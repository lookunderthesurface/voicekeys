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
  candidateFloor: 0.15,        // 低于这个分：连候选都不提（"自信认为不是任何词"的下界）
  fastPathThreshold: 0.95,     // 最高分要达到这个才可能走快速通道
  fastPathMargin: 0.15,        // 且要领先第二名这么多，才算"自信"（用户 2026-11-16 定）
  dualAgreementBelow: 0.95,
  handyWordsAuthoritative: true,
  degradedRequiresAgreement: true,
  // M2 侧：候选词在 M2 转写里的分数 >= 这个值 → 认为 M2 只是"听成近音词"，
  // 这时听 M1 的；低于它 → 认为 M2 听到的是无关内容，否决。
  nearWordScore: 0.45,
  // M2 侧：最高分低于这个 → 自信认为"不是任何词"
  m2Floor: 0.45,
  // M2 侧：最高分和候选词的分数差小于这个，才算"M2 也困惑"（>=这个值说明 M2 更倾向别的词）
  confusionMargin: 0.15,
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
  if (input.score < policy.fastPathThreshold) return false;
  // 用户要求：最高分很高但"第二名也很高"时不能自信，要交给 M2
  if (typeof input.margin === 'number' && input.margin < policy.fastPathMargin) return false;
  return true;
}

/** 两个词是否共享 ≥ minLen 字的连续片段（"听我说"/"我说完了" 共享"我说"） */
function sharesRun(a, b, minLen = 2) {
  const x = String(a || '');
  const y = String(b || '');
  for (let i = 0; i + minLen <= x.length; i += 1) {
    if (y.includes(x.slice(i, i + minLen))) return true;
  }
  return false;
}

/**
 * 由"所有关键词的分数"得出最终裁决（纯函数，便于离线 A/B）。
 * @param {object} input
 * @param {string} input.candidate       M1 提出的词
 * @param {number} input.m1Score         M1 对该词的分数
 * @param {string} [input.m1How]         M1 的匹配方式（exact / prefix / pinyin …），用来判断 M1 够不够确信
 * @param {Array}  input.scored          [{word, score}] 已降序
 * @param {Function} input.thresholdOf   该词的 M2 阈值 (word) => number
 * @param {object} [input.policy]
 * @returns {{action:'fire'|'swap'|'drop', word?:string, why:string, rule:string}}
 */
function verdictFromScores(input) {
  const p = { ...DEFAULT_POLICY, ...(input.policy || {}) };
  const scored = Array.isArray(input.scored) ? input.scored : [];
  const top1 = scored[0] || { word: null, score: 0 };
  const cand = input.candidate;
  const candScore = (scored.find((x) => x.word === cand) || { score: 0 }).score;
  const th = typeof input.thresholdOf === 'function' ? input.thresholdOf : () => p.m2Floor;

  if (top1.score < p.m2Floor) {
    return { action: 'drop', why: 'M2 最高分太低（' + top1.score.toFixed(2) + '）', rule: 'm2-floor' };
  }
  if (top1.word === cand && top1.score >= th(cand)) {
    return { action: 'fire', word: cand, why: 'M2 认同候选词（' + top1.score.toFixed(2) + '）', rule: 'm2-agree' };
  }
  if (top1.word === cand) {
    // M2 听到的就是候选词，但分数没过阈值 → 证据不足，丢弃（不能当"近音"，更不能改判到自己）
    return { action: 'drop', rule: 'm2-weak-same-word',
      why: 'M2 听到候选词但分数不够（' + top1.score.toFixed(2) + ' < ' + th(cand).toFixed(2) + '）' };
  }

  // top1 就是候选词但没过阈值 → 属于"M2 听得弱"，不是"听成近音词"，不能走这条
  const isPartner = top1.word && top1.word !== cand && sharesRun(cand, top1.word, 2);
  const confused = isPartner && candScore >= p.nearWordScore
    && (top1.score - candScore) < p.confusionMargin;   // M2 两个词分数相近，才算真困惑
  if (confused) {
    // 只有 M1 是"整句完全等于关键词"（exact）才算 M1 真听清了；否则 M1 自己也困惑，
    // 这时不要听 M1 的，按 M2 的最高分词决定（用户 2026-11-16 定的规则）。
    const m1Sure = input.m1How === 'exact' && input.m1Score >= th(cand);
    if (m1Sure) {
      return { action: 'fire', word: cand, rule: 'm2-confused-m1-decides',
        why: 'M2 听成近音词「' + top1.word + '」，但 M1 是精确命中（' + input.m1Score.toFixed(2) + '），听 M1 的' };
    }
    if (top1.score >= th(top1.word)) {
      return { action: 'swap', word: top1.word, rule: 'm2-confused-both-m2-decides',
        why: 'M1 也没听全（' + (input.m1How || '?') + ' ' + Number(input.m1Score).toFixed(2) + '），M2 更倾「' + top1.word + '」（' + top1.score.toFixed(2) + '），按 M2 的' };
    }
    return { action: 'drop', rule: 'm2-confused-both-unsure',
      why: 'M1 没听全、M2 也只听到「' + top1.word + '」' + top1.score.toFixed(2) + '，都不可靠' };
  }
  if (top1.score < th(top1.word)) {
    // M2 说的"别的词"也没有足够把握 → 不当成改判依据
    return { action: 'drop', rule: 'm2-weak-other',
      why: 'M2 听到「' + top1.word + '」但分数不够（' + top1.score.toFixed(2) + '）' };
  }
  return { action: 'swap', word: top1.word, rule: 'm2-decides',
    why: 'M2 判定为「' + top1.word + '」（候选「' + cand + '」）' };
}

module.exports = { decide, shouldPropose, shouldFastPath, verdictFromScores, sharesRun, DEFAULT_POLICY };
