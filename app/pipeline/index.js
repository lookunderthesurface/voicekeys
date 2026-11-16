// 识别流水线：把"M1 提候选 → 门内 M2 裁决 → 执行"整条链路封装成一个模块。
//
// server.js 只负责接线；识别逻辑全在这里，用户（或他们的 AI）改算法只动这个目录。
//
// 注入依赖：
//   m1.matchAtEnd(text, words, opts) / m1.bestScore(text, words)
//   m2.confirm(samples, timeoutMs)   → {text, ms} | {timeout|error}
//   capture.currentAudio(ms)
//   words()                          → [{word, planKey}]
const policy = require('./policy.js');

class Pipeline {
  constructor(deps) {
    this.deps = deps;
    this.last = null;
    this.policy = policy;   // 供 server 直接用（shouldFastPath 等）
  }

  /**
   * 文本变化时调用：返回候选（null = 不是候选）。
   * 端尾匹配成功、或最高分过了"候选底线"，都算候选。
   */
  propose(text, { threshold, words, voicedMs = 0, wordMeta }) {
    // 领先幅度：给所有词打分，看第一名比第二名高多少（用户 2026-11-16 的方案）
    const marginOf = (txt) => {
      try {
        if (typeof this.deps.m1.scoreAll !== 'function') return null;
        const s = this.deps.m1.scoreAll(txt, (words || []).map((w) => ({ word: w.word, planKey: w.planKey })));
        if (!s.length) return null;
        return { best: s[0].score, second: s.length > 1 ? s[1].score : 0, margin: s[0].score - (s.length > 1 ? s[1].score : 0) };
      } catch { return null; }
    };
    // 每词阈值：没单独设就用全局默认（见 app/server.js 的 wordMeta 构造）
    const m1Of = (w) => {
      const m = wordMeta && wordMeta.get ? wordMeta.get(w) : null;
      return m && typeof m.m1 === 'number' ? m.m1 : threshold;
    };
    const list = words || this.deps.words();
    if (!text || !list.length) return null;

    const endMatch = this.deps.m1.matchAtEnd(text, list, { threshold });
    if (endMatch && !endMatch.ambiguous && endMatch.score >= m1Of(endMatch.word)) {
      const mAnchor = marginOf(text);
      return {
        word: endMatch.word,
        score: endMatch.score,
        how: endMatch.how,
        degraded: endMatch.how !== 'exact',
        source: 'end-anchored',
        margin: mAnchor ? mAnchor.margin : null,
        second: mAnchor ? mAnchor.second : null,
      };
    }

    const best = this.deps.m1.bestScore(text, list);
    const verdict = policy.shouldPropose(best, { threshold });
    if (!verdict.propose) return null;   // M1 判"否" → 直接丢，不打扰 M2

    const mLoose = marginOf(text);
    return {
      word: best.word,
      score: best.score,
      how: best.how || 'loose',
      degraded: true,
      source: 'loose-screen',
      margin: mLoose ? mLoose.margin : null,
      second: mLoose ? mLoose.second : null,
      note: verdict.reason,
    };
  }

  /**
   * 候选成立的那一刻调用：把这段音频发给 M2（不等门到期，为的是把 30ms 藏在门里）。
   * 返回一个句柄，门到期时交给 finish()。
   */
  startConfirm() {
    try {
      const audio = this.deps.audio();
      if (!audio || audio.length <= 1600) return { audio: null, promise: null };
      return { audio, promise: this.deps.m2.confirm(audio, 3000) };
    } catch {
      return { audio: null, promise: null };
    }
  }

  /** 门到期：等 M2 结果，按策略给出最终动作 */
  async finish(candidate, handle, { threshold, isHandy, retryAudio, wordMeta }) {
    // M2 认可某个词所需的最低分：优先用该词自己的 m2 阈值
    const m2ThresholdOf = (w) => {
      const m = wordMeta && wordMeta.get ? wordMeta.get(w) : null;
      return m && typeof m.m2 === 'number' ? m.m2 : threshold;
    };
    // 唤醒/结束词（isHandy）用"任意位置匹配"：它们天生出现在连续说话里，
    // 要求"句尾匹配"会让"说完马上接话"必失败（用户 B 实验）。
    // M2 给出的是"整句话"，关键词可能出现在句中（尤其唤醒/结束词后面接着说话）。
    // 所以 M2 这一侧统一用 findWord（滑窗找词），不用 matchAtEnd。
    const m2MatchOf = (text, list, minThreshold) => {
      const fn = this.deps.m1.findWord || this.deps.m1.matchOne;
      return text ? fn.call(this.deps.m1, text, list, { threshold: minThreshold }) : null;
    };

    let v = null;   // verdictFromScores 的结论（M2 无结果时保持 null）
    let m2 = { usable: false, word: null, text: '', ms: null };
    if (handle && handle.promise) {
      try {
        const out = await handle.promise;
        if (out && !out.timeout && !out.error) {
          const list = this.deps.words();
          // 先用"所有 m2 阈值里最低的那个"去匹配，避免某个词阈值低而漏掉候选；
          // 再按该词自己的 m2 阈值筛一遍（阈值来自 Calibrator 的每词设置）。
          let minM2 = threshold;
          if (wordMeta && typeof wordMeta.forEach === 'function') {
            wordMeta.forEach((m) => { if (m && typeof m.m2 === 'number' && m.m2 < minM2) minM2 = m.m2; });
          }
          // 裁决逻辑统一放在 policy.verdictFromScores（纯函数）：
          // 运行时和离线 A/B 用同一份代码，避免"测的和跑的不一样"。
          const scored = (typeof this.deps.m1.scoreAll === 'function')
            ? this.deps.m1.scoreAll(out.text || '', list)
            : (() => { const b = m2MatchOf(out.text, list, 0); return b ? [{ word: b.word, score: b.score }] : []; })();
          v = policy.verdictFromScores({
            candidate: candidate.word,
            m1Score: candidate.score,
            scored,
            thresholdOf: (w) => m2ThresholdOf(w),
          });
          m2 = {
            usable: true,
            text: out.text || '',
            word: v.action === 'fire' || v.action === 'swap' ? v.word : null,
            ms: out.ms || null,
            decision: v,
            top1: scored[0] ? scored[0].word : null,
            top1Score: scored[0] ? scored[0].score : 0,
          };
        }
      } catch (e) {
        // 不能静默吞：曾经因为 deps.m1 少传 findWord，这里抛错被吞掉，
        // 表现是"M2 无结果"，查了很久才定位。现在记下来。
        if (this.deps.log) this.deps.log('M2 裁决出错: ' + (e && e.message));
        else console.error('[pipeline] M2 裁决出错: ' + (e && e.message));
      }
    }

    // 有 M2 结论就直接用（verdictFromScores 已是完整策略：近音词听 M1、弱证据丢弃等闸门）
    let verdict;
    if (v) {
      verdict = { action: v.action, word: v.word, reason: v.why, rule: v.rule };
    } else {
      // M2 没给结果（超时/出错/根本没候选）→ 只有 M1 够自信才执行
      const p = this.deps.policy || policy.DEFAULT_POLICY;
      verdict = candidate.score >= p.dualAgreementBelow
        ? { action: 'fire', word: candidate.word, reason: 'M2 无结果，但 M1 置信度高', rule: 'm1-confident' }
        : { action: 'drop', reason: 'M2 无结果且 M1 置信度不足', rule: 'no-evidence' };
    }


    this.last = { at: Date.now(), candidate, m2, verdict };
    return { ...verdict, m2 };
  }

  state() {
    return { last: this.last, policy: policy.DEFAULT_POLICY };
  }
}

module.exports = { Pipeline, policy };
