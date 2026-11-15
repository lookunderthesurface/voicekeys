// 两个模型的协同策略（纯函数，便于替换与测试）
//
// 架构（2026-11-16 用户定）：
//   M1 流式 14M：只做**候选提出**。允许很宽松——把"可能像某个词"的句子挑出来，
//                同时用"候选底线"控制要不要惊动 M2（省资源）。
//   M2 非流式 80MB：**真正的裁决者**。在静音门里重听这段音频，结论说了算。
//
// 规则（全部有实测依据）：
//   ① 候选底线：M1 最高分 < floor 就不惊动 M2（纯噪声）
//   ② 缺字共识：M1 只是缺字/前缀命中时，必须 M2 也认同才执行
//      —— 用户原话："允许缺字的时候要两个模型都赞同"
//   ③ 唤醒/结束词权威：**M1 达到阈值时**，M2 不得否决
//      —— 实测 Handy 因为 M2 只听到「完了」而停不下来
//   ④ M1 只是宽松候选（低于阈值）时，即使 handy 词也要 M2 认同，否则丢
//      —— 防止把「播完了」这种噪声当成"停止"

const DEFAULT_POLICY = {
  candidateFloor: 0.15,   // 实测扫描：0.15 比 0.35 多 3 个点召回，M2 调用 +11%，零误判词
  fastPathThreshold: 0.95, // M1 端尾匹配达到这个分数就自己判，不叫 M2
  dualAgreementBelow: 0.95,
  handyWordsAuthoritative: true,
  degradedRequiresAgreement: true,
};

/**
 * M1 这句话要不要提出候选（要不要惊动 M2）
 * @param {{score:number}} best
 * @param {{threshold?:number, policy?:object}} opts
 */
function shouldPropose(best, opts = {}) {
  const policy = { ...DEFAULT_POLICY, ...(opts.policy || {}) };
  if (!best) return { propose: false, reason: 'M1 没给出任何候选', degraded: false };
  const score = Number(best.score) || 0;
  const threshold = Number(opts.threshold) || 0.7;

  if (score >= threshold) return { propose: true, reason: 'M1 达到阈值', score, degraded: false };
  if (score >= policy.candidateFloor) {
    return { propose: true, reason: `M1 只有 ${score.toFixed(2)}，交给 M2 裁决`, score, degraded: true };
  }
  return { propose: false, reason: `M1 最高分 ${score.toFixed(2)} 低于候选底线`, score, degraded: false };
}

/**
 * 门到期时的最终决定
 * @param {object} input
 * @param {string} input.word
 * @param {number} input.m1Score
 * @param {string} input.m1How
 * @param {string|null} input.m2Word
 * @param {string} input.m2Text
 * @param {boolean} input.m2Usable
 * @param {boolean} input.isHandy
 * @param {number} [input.threshold]
 * @param {object} [input.policy]
 * @returns {{action:'fire'|'swap'|'drop', word?:string, reason:string, rule:string}}
 */
/**
 * 门到期时的决定。原则：M1 判不准就问 M2，**问了就听 M2 的**。
 *
 * @param {object} input
 * @param {string} input.word        M1 提出的词
 * @param {number} input.m1Score
 * @param {string} input.m1How
 * @param {string|null} input.m2Word M2 在同样音频上匹配到的词（null = 没匹配到）
 * @param {string} input.m2Text
 * @param {boolean} input.m2Usable   M2 是否给出可用结果
 * @param {number} [input.threshold]
 * @param {object} [input.policy]
 */
function decide(input) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy || {}) };
  const { word, m1Score, m1How, m2Word, m2Text, m2Usable } = input;
  const threshold = Number(input.threshold) || 0.7;
  const text = m2Text || '空';

  // M2 没给出结果（超时/出错）→ 只有 M1 够自信才执行
  if (!m2Usable) {
    if (m1Score >= policy.dualAgreementBelow) {
      return { action: 'fire', word, reason: 'M2 无结果，但 M1 置信度高', rule: 'm1-confident' };
    }
    return { action: 'drop', reason: 'M2 无结果且 M1 置信度不足', rule: 'no-evidence' };
  }

  // M2 认同 M1 的词
  if (m2Word === word) {
    return {
      action: 'fire',
      word,
      reason: m1How === 'exact' && m1Score >= threshold ? '两个模型都认同' : '两个模型都认同（含缺字容错）',
      rule: 'agree',
    };
  }

  // M2 认为是另一个词 → **听 M2 的**（M1 判不准才问的，问了就认）
  if (m2Word) {
    return { action: 'swap', word: m2Word, reason: `M2 判定为「${m2Word}」（M1 听成「${word}」）`, rule: 'm2-decides' };
  }

  // M2 什么词都没听出来 → 丢弃（不再用 M1 兜底）
  if (policy.degradedRequiresAgreement && m1How !== 'exact' && m1Score < policy.dualAgreementBelow) {
    return {
      action: 'drop',
      reason: `M1 只是缺字命中（${m1How} ${m1Score.toFixed(2)}），M2 听到「${text}」`,
      rule: 'degraded-needs-agreement',
    };
  }
  return { action: 'drop', reason: `M2 听到「${text}」不是一个词`, rule: 'm2-veto' };
}

/**
 * 要不要走"快速通道"（M1 自己判，不叫 M2）。
 * 用户定：M1 口齿清楚时自己判对，就不用惊动 M2。
 */
function shouldFastPath(input) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy || {}) };
  if (!input || typeof input.score !== 'number') return false;
  return input.score >= policy.fastPathThreshold;
}
module.exports = { decide, shouldPropose, shouldFastPath, DEFAULT_POLICY };
