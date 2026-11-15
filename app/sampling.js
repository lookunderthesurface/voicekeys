// 采样策略：决定一段录音值不值得进"校准数据集"。
//
// 设计原则（2026-11-15 与用户共同定的）：
//   · 已经能认对的词，样本没有学习价值——教师模型和我们听起来都是"真"，
//     存下来只是占坑；所以按词统计"一致率"，一致率高的词只留极少量对照样本。
//   · 真正有价值的是"不一致"：我们听错、教师听对；或者我们误触发。
//   · 规则集中在这一个文件里，方便以后按数据调整——不要在 capture 里堆 if。
//
// 所有阈值都在 DEFAULT_POLICY 里，可被 settings.json 的 sampling 字段覆盖。

const DEFAULT_POLICY = {
  maxSamples: 100,          // 总容量（和 capture 的上限一致）
  optimizedCap: 1,          // 已优化词最多留几段
  unknownCap: 8,            // 未优化词最多留几段
  optimizedAgreement: 0.80, // 一致率达到多少算"已优化"（0.9 太严：真人说话总有几次意外，实测 7 对 1 错=0.88 就该算稳）
  optimizedMinSamples: 4,   // 至少要有几段数据才敢判断
  band: [0.40, 0.85],       // 模糊带：像但没够
  shortTranscriptRatio: 0.3,// "有声但没转出字"最多占多少比例
  backgroundEvery: 20,      // 每 N 段留 1 段背景对照
};

/** 一段录音的静态特征（不依赖历史统计） */
function describe(sample) {
  const text = (sample.text || '').replace(/[\s，。,.!！?？]/g, '');
  return {
    textLen: text.length,
    score: Number(sample.score || 0),
    fired: Boolean(sample.fired),
    voicedMs: Number(sample.voicedMs || 0),
    ms: Number(sample.ms || 0),
    voiceRatio: Number(sample.voicedMs || 0) / Math.max(1, Number(sample.ms || 1)),
    word: sample.bestWord || '',
  };
}

/**
 * 从已有的采集索引 + 最近的校准报表，统计每个词的"一致率"。
 * 一致 = 教师认为这是该词，而且我们当时也确实命中了该词。
 */
function wordStats(entries, report) {
  const stats = {};
  const bump = (word, key) => {
    if (!word) return;
    if (!stats[word]) stats[word] = { agree: 0, disagree: 0, total: 0 };
    stats[word][key] += 1;
    stats[word].total += 1;
  };

  if (report && Array.isArray(report.rows)) {
    for (const row of report.rows) {
      const teacherWord = row.teacherWord || '';
      const ourWord = row.fired ? (row.firedWord || row.bestWord || '') : '';
      if (!teacherWord && !ourWord) continue;
      if (teacherWord && teacherWord === ourWord) bump(teacherWord, 'agree');
      else bump(teacherWord || ourWord, 'disagree');
    }
  } else {
    // 没有报表时退回"自己的置信度"：满分命中视为一致
    for (const e of entries || []) {
      const w = e.fired ? (e.firedWord || e.bestWord) : (e.bestWord || '');
      if (!w) continue;
      if (e.fired && Number(e.bestScore) >= 0.9) bump(w, 'agree');
      else bump(w, 'disagree');
    }
  }

  for (const s of Object.values(stats)) {
    s.agreement = s.total ? s.agree / s.total : 0;
  }
  return stats;
}

/** 哪些词已经"优化过了"（认得很稳，不需要继续喂样本） */
function optimizedWords(stats, policy = DEFAULT_POLICY) {
  const out = new Set();
  for (const [word, s] of Object.entries(stats || {})) {
    if (s.total >= policy.optimizedMinSamples && s.agreement >= policy.optimizedAgreement) out.add(word);
  }
  return out;
}

/** 某个词已经存了几段（用于配额） */
function countForWord(entries, word) {
  if (!word) return 0;
  return (entries || []).filter((e) => (e.firedWord || e.bestWord) === word).length;
}

/**
 * 判定一段录音要不要存。
 * @returns {{keep:boolean, reason:string, value:number}}
 */
function decide(sample, ctx = {}) {
  const policy = { ...DEFAULT_POLICY, ...(ctx.policy || {}) };
  const d = describe(sample);
  const entries = ctx.entries || [];
  const stats = ctx.stats || {};

  // 0. 硬门槛：太短 / 没声音
  if (d.ms < 300) return { keep: false, reason: 'too-short', value: 0 };
  if (d.voicedMs < 200) return { keep: false, reason: 'no-voice', value: 0 };

  // 1. 诊断模式：全收（由 capture 控制上限）
  if (ctx.diagnostic) return { keep: true, reason: 'diagnostic', value: 0.5 };

  const word = d.word;
  const stat = stats[word] || null;
  const optimized = stat && stat.total >= policy.optimizedMinSamples && stat.agreement >= policy.optimizedAgreement;

  // 2. 触发了的：一定有价值（可能误触发），但已优化词也有配额
  if (d.fired) {
    const used = countForWord(entries, word);
    const cap = optimized ? policy.optimizedCap : policy.unknownCap;
    if (used >= cap) return { keep: false, reason: `已优化词的配额已满(${word})`, value: 0.2 };
    return { keep: true, reason: 'fired', value: Number((1 - d.score + 0.3).toFixed(2)) };
  }

  // 3. 模糊带：像但没够 —— 最有信息量
  if (d.score >= policy.band[0] && d.score < policy.band[1]) {
    return { keep: true, reason: 'borderline', value: 0.9 };
  }

  // 4. 有声但几乎没转出字：可疑漏检
  if (d.textLen <= 1 && d.voicedMs >= 400 && d.ms <= 4000 && d.voiceRatio >= 0.2) {
    const quota = Math.floor(policy.maxSamples * policy.shortTranscriptRatio);
    const used = (entries || []).filter((e) => e.why === 'short-transcript').length;
    if (used < quota) return { keep: true, reason: 'short-transcript', value: 0.7 };
    return { keep: false, reason: 'short-transcript 配额已满', value: 0 };
  }

  // 5. 背景对照：每 N 段留 1 段（未优化词优先）
  if (entries.length > 0 && entries.length % policy.backgroundEvery === 0
      && d.voicedMs >= 500 && d.ms <= 6000) {
    if (!optimized) return { keep: true, reason: 'background', value: 0.3 };
  }

  return { keep: false, reason: 'unrelated', value: 0 };
}

module.exports = { decide, wordStats, optimizedWords, countForWord, describe, DEFAULT_POLICY };
