// 默认采样算法：按词统计一致率，已优化的词不占配额，边界样本优先。
const sampling = require('../sampling.js');

// 契约（必须实现）：
//   decide(sample, ctx) -> {keep:boolean, reason:'fired'|'borderline'|'short-transcript'|'background'|'diagnostic'|string, value?:number}
//   sample: {text, score, fired, voicedMs, ms, bestWord}
//   ctx:    {entries, stats, policy, diagnostic}
module.exports = {
  name: 'default-value-sampling',
  decide: sampling.decide,
  // 辅助函数（非契约要求）
  wordStats: sampling.wordStats,
  optimizedWords: sampling.optimizedWords,
  DEFAULT_POLICY: sampling.DEFAULT_POLICY,
};
