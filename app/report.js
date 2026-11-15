// 报表：把"我们的判定"和"老师的转写"摆在一起，给出诊断与建议。
//
// 核心思路：老师的转写当作真值（用户明确：0.6B 说对就是对），但要区分故障出在哪一层：
//   · 老师能对上、我们没触发 → 漏检
//       - 我们的转写和老师不同  → **ASR 模型听错**
//       - 我们的转写和老师相同  → **匹配规则太严**
//   · 我们触发了、老师对不上 → 误触发（同理分两类）
const path = require('node:path');
const { matchOne, bestScore, normalize, toPinyin, editDistance } = require('./matcher.js');

const MATCH_THRESHOLD = 0.70;

function classify(entry, teacherText, words, threshold = MATCH_THRESHOLD) {
  const ourText = entry.ourText || '';
  const teacherBest = teacherText ? bestScore(teacherText, words) : null;
  const ourBest = bestScore(ourText, words);

  // 老师的转写里**直接包含**某个绑定的词，也算老师判真。
  // 匹配器的长度护栏会把"说完了，我说完了。"这种长句挡掉，但老师确实听到了这个词。
  const normalizedTeacher = normalize(teacherText || '');
  const teacherContainsWord = words.find((w) => {
    const wk = normalize(w.word || '');
    return wk.length >= 2 && normalizedTeacher.includes(wk);
  });
  const teacherMatched = teacherText ? matchOne(teacherText, words, { threshold }) : null;
  const ourMatched = ourText ? matchOne(ourText, words, { threshold }) : null;
  const ourAmbiguous = Boolean(ourMatched && ourMatched.ambiguous);
  const teacherWord = (teacherMatched && !teacherMatched.ambiguous ? teacherMatched.word : null)
    || (teacherContainsWord ? teacherContainsWord.word : null);
  const weFired = Boolean(entry.fired);

  let verdict = '';
  let advice = '';

  if (teacherWord && weFired) {
    if (entry.firedWord === teacherWord) {
      verdict = '一致（真命中）';
    } else {
      verdict = '命中但词不对';
      advice = `我们执行了「${entry.firedWord}」，老师听到的是「${teacherWord}」——这两个词太像，考虑删掉其中一个或换成区别更大的说法`;
    }
  } else if (teacherWord && !weFired && ourAmbiguous) {
    // 我们自己判成歧义（比如只说「把声音调」，大/小都可能）——不触发是设计如此
    verdict = '歧义拦下（预期行为）';
  } else if (teacherWord && !weFired) {
    const sameText = normalize(ourText) === normalize(teacherText);
    verdict = sameText ? '漏检（规则太严）' : '漏检（我们听错了）';
    if (!sameText) {
      const pyA = toPinyin(ourText);
      const pyB = toPinyin(teacherWord);
      const dist = pyA.length && pyB.length ? editDistance(pyA, pyB) : 99;
      if (ourAmbiguous) {
        advice = `我们听成了「${ourText}」，它同时像 ${ourMatched.ambiguous.join('、')} —— 把这两个词改得差别更大（例如「调大一点」「调小一点」）`;
      } else if (ourText && shouldSuggest(ourText, teacherWord, words)) {
        advice = `建议把「${ourText}」加为「${teacherWord}」的同义词`;
      } else if (normalize(ourText).length <= 2) {
        advice = `我们只听到「${ourText}」——模型没听全，建议把「${teacherWord}」换成更短更清晰的词`;
      } else {
        advice = `差距较大（我们：${ourText}；老师：${teacherWord}，差 ${dist} 个音节），建议换一个更清晰的词，或靠近麦克风说`;
      }
    } else {
      advice = '我们的转写是对的，但匹配分数不够 → 可以考虑放宽匹配规则';
    }
    if (!advice && normalize(ourText).length <= 2) {
      advice = `我们只听到「${ourText}」（1~2 个字）——模型没听全，建议把「${teacherWord}」换成更短更清晰的词`;
    }
  } else if (!teacherWord && weFired) {
    const sameText = normalize(ourText) === normalize(teacherText);
    verdict = sameText ? '误触发（规则太松）' : '误触发（我们听错了）';
    advice = sameText ? '这个词本来不该触发，考虑提高匹配阈值或删词' : '我们把它听成了命令，考虑提高匹配阈值';
  } else {
    verdict = '一致（不触发）';
  }

  return {
    ...entry,
    teacherText: teacherText || '',
    teacherWord: teacherWord || '',
    teacherScore: teacherBest ? Number(teacherBest.score.toFixed(3)) : 0,
    ourScore: ourBest ? Number(ourBest.score.toFixed(3)) : 0,
    ourBestWord: ourBest ? ourBest.word : '',
    verdict,
    advice,
  };
}

/**
 * 是否值得把「我们的转写」加成同义词：拼音距离小、长度接近，且不是完整句子。
 * 例：「定视频」vs「暂停视频」→ 差 1 个音节，长度 3 vs 4 → 建议
 *     「播放音乐」vs「播放视频」→ 差 2 个音节，但它是常用词 → 不建议（调用方过滤）
 */
const COMMON_WORDS = new Set(['播放音乐', '播放', '暂停', '音乐', '视频', '声音', '打开', '关闭', '开始', '结束']);

function shouldSuggest(ourText, teacherWord, words) {
  const n1 = normalize(ourText);
  const n2 = normalize(teacherWord);
  if (!n1 || !n2) return false;
  if (COMMON_WORDS.has(n1)) return false;               // 常用词不要加，会误触发
  if (matchOne(ourText, words, { threshold: MATCH_THRESHOLD })) return false;  // 已经能匹配上

  // 只在"确实只是说了一半或差一个音"时才建议加同义词。
  // 差 2 个音节以上的（如「哦播放式瓶」vs「播放视频」）加了也没意义——那是模型听错，不是说法不同。
  if (n2.startsWith(n1) && n1.length >= 2) return true;   // 只说了前半截
  const a = toPinyin(ourText);
  const b = toPinyin(teacherWord);
  if (!a.length || !b.length) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return editDistance(a, b) <= 1;                        // 差一个音（同音字/近音）
}

/**
 * @param {Array} entries 采集索引
 * @param {Record<string,string>} teacherTexts 文件名 → 老师转写
 * @param {Array} words [{word, planKey}]
 */
function buildReport(entries, teacherTexts, words, threshold = MATCH_THRESHOLD) {
  const rows = entries.map((e) => classify(e, teacherTexts[e.file] || '', words, threshold));
  const summary = {
    total: rows.length,
    truePositive: rows.filter((r) => r.verdict === '一致（真命中）').length,
    falseNegative: rows.filter((r) => r.verdict.startsWith('漏检')).length,
    falsePositive: rows.filter((r) => r.verdict.startsWith('误触发')).length,
    wrongWord: rows.filter((r) => r.verdict === '命中但词不对').length,
    trueNegative: rows.filter((r) => r.verdict === '一致（不触发）').length,
    ambiguousSafe: rows.filter((r) => r.verdict.startsWith('歧义拦下')).length,
  };
  const modelError = rows.filter((r) => r.verdict.includes('我们听错')).length;
  const ruleError = rows.filter((r) => r.verdict.includes('规则太')).length;
  const suggestions = [...new Set(rows.map((r) => r.advice).filter((a) => a.startsWith('建议把')))];

  const sweep = sweepThresholds(rows);

  return {
    at: new Date().toISOString(),
    summary: { ...summary, modelError, ruleError },
    suggestions,
    thresholdSweep: sweep,
    thresholdAdvice: recommendThreshold(sweep, rows.length),
    rows,
  };
}

/**
 * 用老师当真值，扫一遍匹配阈值，看每个阈值下会错多少。
 * 这正是"阈值该定多少"的答案来源：不靠拍脑袋，靠这批真实数据。
 */
function sweepThresholds(rows, from = 0.50, to = 0.90, step = 0.05) {
  const out = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const th = Number(t.toFixed(2));
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of rows) {
      const truth = Boolean(r.teacherWord);          // 老师认为这是一条命令
      const predicted = r.ourScore >= th;            // 这个阈值下我们会触发
      if (predicted && truth && r.ourBestWord === r.teacherWord) tp += 1;
      else if (predicted) fp += 1;
      else if (truth) fn += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    out.push({
      threshold: th, tp, fp, fn,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
      f1: Number(f1.toFixed(3)),
    });
  }
  return out;
}

/**
 * 从扫描结果里挑建议值。
 * 主建议取 F1 最高（平衡误触发与漏检）；另外单独给出"零误触发"的那一档作参考，
 * 但如果它把召回砍得太狠（< 主建议召回的 70%），就直接说明不划算——实测里这种情况很常见：
 * 阈值一高，前缀匹配（0.85）和拼音匹配（0.75）全被砍掉，反而漏一大片。
 */
function recommendThreshold(sweep, sampleSize, floor = 0.60) {
  if (!sweep.length) return null;
  const usable = sweep.filter((s) => s.threshold >= floor);
  const pool = usable.length ? usable : sweep;
  const byF1 = pool.reduce((a, b) => (b.f1 > a.f1 || (b.f1 === a.f1 && b.threshold > a.threshold) ? b : a));
  const safe = pool.filter((s) => s.fp === 0 && s.tp > 0);
  const safeBest = safe.length
    ? safe.reduce((a, b) => (b.recall > a.recall || (b.recall === a.recall && b.threshold > a.threshold) ? b : a))
    : null;

  const notes = [];
  if (safeBest && safeBest.recall >= byF1.recall * 0.7) {
    notes.push(`若一次误触发都不能有，可用 ${safeBest.threshold.toFixed(2)}（召回 ${safeBest.recall.toFixed(2)}）`);
  } else if (safeBest) {
    notes.push(`${safeBest.threshold.toFixed(2)} 能做到零误触发，但召回会掉到 ${safeBest.recall.toFixed(2)}，不划算`);
  }

  return {
    threshold: byF1.threshold,
    reason: '按 F1（误触发与漏检的平衡）最高选出',
    precision: byF1.precision,
    recall: byF1.recall,
    fp: byF1.fp,
    fn: byF1.fn,
    zeroFalseAlarm: safeBest ? { threshold: safeBest.threshold, recall: safeBest.recall, fn: safeBest.fn } : null,
    notes,
    sampleSize,
    reliable: sampleSize >= 20,
  };
}

module.exports = { buildReport, classify, shouldSuggest, sweepThresholds, recommendThreshold, MATCH_THRESHOLD };
