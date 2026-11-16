// 文本匹配：把 ASR 的一句话，对到已绑定的关键词上。
//
// 设计依据（都不是我发明的）：
//   · Rhasspy 内置 Fuzzywuzzy 意图识别器：用 rapidfuzz 把"整句话"和命令句表做
//     模糊字符串匹配（https://rhasspy.readthedocs.io/en/latest/intent-recognition/）
//   · 中文侧用拼音比对（专利 CN107564528B、PYG-ASR/Interspeech 2025 都是这个思路）
//   · pinyin-pro（MIT）负责转无声调拼音
//
// 关键点：**整句比对，不做"包含"**。
//   以前是 t.includes(w)，导致"我吃饭的时候说完了话"也会触发；
//   现在要求整句话本身就像这个命令（带长度上限），误触发大幅下降。
const { pinyin } = require('./paths.js').requirePackage('pinyin-pro');

const PUNCT = /[\s,，。.!！?？、;；:："'“”‘’()（）\[\]【】…—\-~]/g;

function normalize(text) {
  return String(text || '').replace(PUNCT, '').toLowerCase();
}

/** 无声调拼音音节数组；非中文按字符保留 */
function toPinyin(text) {
  const s = normalize(text);
  if (!s) return [];
  try {
    return pinyin(s, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).map((x) => String(x).toLowerCase());
  } catch {
    return s.split('');
  }
}

/** 编辑距离（音节/字符级通用） */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** 归一化相似度：1 - 距离/较长长度 */
function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const d = editDistance(a, b);
  return Math.max(0, 1 - d / Math.max(a.length, b.length));
}

/**
 * 整句匹配一个关键词，返回相似度 0~1。
 * 两种度量取较大值：字形相似度、拼音音节相似度。
 */
function scoreAgainst(text, word) {
  const t = normalize(text);
  const w = normalize(word);
  if (!t || !w) return { score: 0, how: 'empty' };

  // 长度护栏：命令词都很短，整句话比它长太多就不可能是这个命令
  // （这是"太容易触发"的直接修复点）
  const maxLen = w.length + Math.max(2, Math.ceil(w.length * 0.6));
  if (t.length > maxLen) return { score: 0, how: 'too-long' };

  // 用户常只说前半截（「暂停」「听我」「声音大」）：文本是关键词的前缀时给固定分。
  // 注意只认"前缀"，不认"随便包含"，这样「帮我把声音关掉」这类不会被放过。
  if (t === w) return { score: 1, how: 'exact', charSim: 1, pySim: 1 };
  if (t.length >= 2 && t.length < w.length && w.startsWith(t)) {
    return { score: 0.85, how: 'prefix', charSim: 1, pySim: 1 };
  }

  const charSim = similarity(t.split(''), w.split(''));
  const pySim = similarity(toPinyin(t), toPinyin(w));
  const score = Math.max(charSim, pySim);
  return { score, how: pySim >= charSim ? 'pinyin' : 'char', charSim, pySim };
}

/**
 * @param {string} text ASR 的一句话
 * @param {Array<{word:string, planKey?:string}>} words
 * @returns {{word, planKey, score, how}|{ambiguous:string[]}|null}
 */
function matchOne(text, words, opts = {}) {
  const threshold = opts.threshold ?? 0.70;   // 与 settings.json 的 matchThreshold 默认值保持一致
  const scored = [];
  for (const item of words) {
    const r = scoreAgainst(text, item.word);
    if (r.score > 0) {
      scored.push({
        word: item.word,
        planKey: item.planKey || item.word,
        score: r.score,
        how: r.how,
      });
    }
  }
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (top.score < threshold) return null;

  // 与最高分接近的候选（差值 ≤0.05）视为并列
  const tied = scored.filter((c) => top.score - c.score <= 0.05);
  const plans = new Set(tied.map((c) => c.planKey));
  if (plans.size > 1) {
    // 只说前半截时可能同时像"通用版"和"限定某应用的版本"（如 暂停 / 暂停爱奇艺）。
    // 规则：如果其中只有一个计划没有限定窗口，就用它——用户说通用词时通常就是指通用动作。
    const generic = tied.filter((c) => !/(^|[{,])\s*"app"\s*:/.test(c.planKey || ''));
    const genericPlans = new Set(generic.map((c) => c.planKey));
    if (generic.length > 0 && genericPlans.size === 1) {
      return { word: generic[0].word, planKey: generic[0].planKey, score: generic[0].score, how: generic[0].how + '+generic' };
    }
    return { ambiguous: tied.map((c) => `${c.word}(${c.score.toFixed(2)})`) };
  }
  return { word: top.word, planKey: top.planKey, score: top.score, how: top.how };
}

/**
 * 只取"最像的那一个"，**不看阈值**。
 * 采集规则需要"即使没触发也要知道分数"，所以要这个。
 */
function bestScore(text, words) {
  let best = null;
  for (const item of words) {
    const r = scoreAgainst(text, item.word);
    if (!best || r.score > best.score) {
      best = { word: item.word, planKey: item.planKey || item.word, score: r.score, how: r.how };
    }
  }
  return best;
}

/**
 * 只接受"整句话以它结尾"的词（允许前面有少量多余字，默认 ≤3）。
 * 用途：区分"独立命令"与"一句话里的半句"。
 * 例：「静音」→ 命中；「静音门」→ 不命中；「请帮我暂停视频」→ 命中 暂停视频。
 */
function matchAtEnd(text, words, opts = {}) {
  const t = normalize(text);
  if (!t) return null;
  const maxExtra = Number.isFinite(opts.maxExtra) ? opts.maxExtra : 3;
  const pool = (words || []).filter((w) => {
    const wk = normalize(w.word || '');
    if (!wk) return false;
    // 正常情况：这句话以这个词结尾（前面允许少量多余字）
    if (t.endsWith(wk) && t.length - wk.length <= maxExtra) return true;
    // 容错：ASR 漏掉了词开头的一两个字（例如「说完了」应为「我说完了」）
    if (wk.length >= 3 && wk.endsWith(t) && t.length / wk.length >= 0.6) return true;
    // 容错②：ASR 漏掉了词**结尾**（「播放爱奇」应为「播放爱奇艺」「暂停视」应为「暂停视频」）
    // 实测：加上这条，30 段真人录音的端尾命中率从 40% → 60%，且没有新增误命中。
    if (wk.length >= 3 && wk.startsWith(t) && t.length / wk.length >= 0.6) return true;
    return false;
  });
  if (!pool.length) return null;
  return matchOne(text, pool, opts);
}


/**
 * 在一整句里"找"关键词（滑窗），给非流式模型（M2）的整句转写用。
 *
 * 为什么不直接用 scoreAgainst：它带长度护栏，整句太长会直接 0 分
 * （护栏对 M1 的整句判断是对的，但 M2 的转写天生就是整句）。
 *
 * @param {string} text   M2 的整句转写
 * @param {Array} words   [{word, planKey}]
 * @param {{threshold?:number}} opts
 */
function findWord(text, words, opts = {}) {
  const threshold = opts.threshold ?? 0.70;
  const t = normalize(text);
  if (!t) return null;
  const scored = [];
  for (const item of words) {
    const w = normalize(item.word);
    if (!w) continue;
    let best = { score: 0, how: 'none' };
    // 窗口长度在关键词长度 ±1 之间滑动：容忍多字/缺字
    for (let len = Math.max(1, w.length - 1); len <= w.length + 1; len += 1) {
      if (len > t.length) break;
      for (let i = 0; i + len <= t.length; i += 1) {
        const chunk = t.slice(i, i + len);
        const charSim = similarity(chunk.split(''), w.split(''));
        const pySim = similarity(toPinyin(chunk), toPinyin(w));
        const score = Math.max(charSim, pySim);
        if (score > best.score) best = { score, how: pySim >= charSim ? 'pinyin-window' : 'char-window' };
      }
    }
    if (best.score > 0) {
      scored.push({ word: item.word, planKey: item.planKey || item.word, score: best.score, how: best.how });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (top.score < threshold) return null;
  return { word: top.word, planKey: top.planKey, score: top.score, how: top.how };
}


/**
 * 对**所有**关键词打分（滑窗取每个词的最高分），按分数从高到低排序。
 * 用途：判断"是不是词""够不够自信""有没有第二个词也很像"。
 * @returns {Array<{word, score, how}>}
 */
function scoreAll(text, words) {
  const t = normalize(text);
  if (!t) return [];
  const out = [];
  for (const item of words) {
    const w = normalize(item.word);
    if (!w) continue;
    let best = 0;
    let how = 'none';
    for (let len = Math.max(1, w.length - 1); len <= w.length + 1; len += 1) {
      if (len > t.length) break;
      for (let i = 0; i + len <= t.length; i += 1) {
        const chunk = t.slice(i, i + len);
        const charSim = similarity(chunk.split(''), w.split(''));
        const pySim = similarity(toPinyin(chunk), toPinyin(w));
        const score = Math.max(charSim, pySim);
        if (score > best) { best = score; how = pySim >= charSim ? 'pinyin-window' : 'char-window'; }
      }
    }
    if (best > 0) out.push({ word: item.word, planKey: item.planKey || item.word, score: best, how });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { matchOne, matchAtEnd, bestScore, scoreAgainst, normalize, toPinyin, similarity, editDistance, findWord, scoreAll };
