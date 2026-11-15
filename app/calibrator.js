// Calibrator：从"判断素材"里算出该加/该删哪些同义词
//
// 用户 2026-11-16 的设计：
//   A 加法：M1 不确定（对目标词相似度低）、M2 认为对（相似度高）、老师也认为 M2 对
//           → 说明用户实际发音/环境让 M1 听成了某个"谐音"，把那个谐音加成同义词，
//             以后 M1 就能直接命中，节省一次 M2 调用。
//   B 减法：某个同义词经常是 M1 命中、但老师认为这段根本不是它
//           → 这个同义词在制造误触发，建议删掉。
//
//   C 额外：老师在同一段 5 秒录音里听到多次关键词 → 说明前面几次都失败了
//           （用户喊了没反应才会继续喊），这些是"漏检样本"。
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { phone: _phone, phonemeSimilarity } = require(path.join(ROOT, 'app', 'phoneme.js'));

// 只取 matchAtEnd 需要的部分，避免循环依赖
const { similarity } = require(path.join(ROOT, 'app', 'matcher.js'));

/** 在老师给的文字里数某个词出现了几次（严格子序列，不重叠） */
function countOccurrences(text, word) {
  const t = String(text || '').replace(/\s/g, '');
  const w = String(word || '').replace(/\s/g, '');
  if (!t || !w) return 0;
  let count = 0;
  let i = 0;
  while (i <= t.length - w.length) {
    if (t.startsWith(w, i)) { count += 1; i += w.length; } else { i += 1; }
  }
  return count;
}

/** 这段文本里最像哪个词（返回 {word, score} 或 null） */
function bestWord(text, words) {
  let best = null;
  for (const w of words) {
    const s = similarity(text, w.say);
    if (!best || s > best.score) best = { word: w.say, score: s, kind: w.kind, aliasOf: w.aliasOf };
  }
  return best;
}

/**
 * @param {object} input
 * @param {Array} input.entries      capture/index.jsonl 的条目
 * @param {Map<string,string>} input.teacherByFile  文件名 → 老师转写
 * @param {Array} input.words        planner.listVerbose()（含 kind/aliasOf）
 */
function suggest({ entries, teacherByFile, words }) {
  const add = new Map();       // 谐音 → { word, count, samples }
  const remove = new Map();    // 同义词 → { count, samples }
  const repeats = [];          // 同一段里出现多次关键词
  const stats = { total: 0, withTeacher: 0, m2Better: 0, m1Better: 0 };

  for (const e of entries) {
    stats.total += 1;
    const truth = teacherByFile.get(e.file) || '';
    if (!truth) continue;
    stats.withTeacher += 1;

    const candidate = e.ourText ? words.find((w) => w.say === e.ourText) : null;
    const m1Text = String(e.ourText || '');
    const m2Text = String(e.m2Text || '');
    const truthBest = bestWord(truth, words);
    if (!truthBest || truthBest.score < 0.7) {
      // 老师都说这段不是任何关键词 → 看看是不是某个同义词在乱命中
      if (candidate && candidate.kind === 'synonym' && e.fired) {
        const cur = remove.get(candidate.say) || { word: candidate.say, count: 0, samples: [] };
        cur.count += 1;
        if (cur.samples.length < 3) cur.samples.push({ file: e.file, truth, m2: m2Text });
        remove.set(candidate.say, cur);
      }
      continue;
    }

    const target = truthBest.word;
    const targetWord = words.find((w) => w.say === target);

    // A：M1 对目标词相似度低、M2 高、老师也认同 → 把 M1 听到的那个写法当谐音
    const m1Score = m1Text ? similarity(m1Text, target) : 0;
    const m2Score = m2Text ? similarity(m2Text, target) : 0;
    if (m1Score < 0.6 && m2Score >= 0.6) {
      stats.m2Better += 1;
      const variant = (m2Text || m1Text).trim();
      // 谐音不能和主词完全一样，也不能已经存在
      if (variant && variant !== target && !words.some((w) => w.say === variant)) {
        const key = target + '|' + variant;
        const cur = add.get(key) || { word: target, variant, count: 0, samples: [] };
        cur.count += 1;
        if (cur.samples.length < 3) cur.samples.push({ file: e.file, m1: m1Text, m2: m2Text, truth });
        add.set(key, cur);
      }
    } else if (m1Score >= 0.8 && m2Score < 0.5) {
      stats.m1Better += 1;
    }

    // B：我们执行了某个词，但老师认为这段说的不是它 → 误触发，建议删掉那个词
    //    （上面已经把 "老师认为别人" 的情况 continue 掉了，这里只处理老师也认同目标词的场景，
    //      所以真正要判断的是：执行的那个词 == 老师认同的词吗？不是就记一笔）
    const execWord = e.m2Word || (e.fired ? m1Text : '');
    if (e.fired && execWord) {
      const execEntry = words.find((w) => w.say === execWord);
      if (execEntry && execEntry.kind === 'synonym' && execWord !== target) {
        const cur = remove.get(execWord) || { word: execWord, count: 0, samples: [] };
        cur.count += 1;
        if (cur.samples.length < 3) cur.samples.push({ file: e.file, truth, m2: m2Text, exec: execWord });
        remove.set(execWord, cur);
      }
    }

    // C：同一段里出现多次关键词
    const n = countOccurrences(truth, target);
    if (n >= 2) repeats.push({ file: e.file, word: target, times: n, truth });
  }

  return {
    stats,
    addSynonyms: [...add.values()].sort((a, b) => b.count - a.count),
    removeSynonyms: [...remove.values()].sort((a, b) => b.count - a.count),
    repeats: repeats.sort((a, b) => b.times - a.times),
  };
}

module.exports = { suggest, countOccurrences, bestWord };
