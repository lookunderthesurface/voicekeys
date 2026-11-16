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
    // 每词阈值：没单独设就用全局默认（见 app/server.js 的 wordMeta 构造）
    const m1Of = (w) => {
      const m = wordMeta && wordMeta.get ? wordMeta.get(w) : null;
      return m && typeof m.m1 === 'number' ? m.m1 : threshold;
    };
    const list = words || this.deps.words();
    if (!text || !list.length) return null;

    const endMatch = this.deps.m1.matchAtEnd(text, list, { threshold });
    if (endMatch && !endMatch.ambiguous && endMatch.score >= m1Of(endMatch.word)) {
      return {
        word: endMatch.word,
        score: endMatch.score,
        how: endMatch.how,
        degraded: endMatch.how !== 'exact',
        source: 'end-anchored',
      };
    }

    const best = this.deps.m1.bestScore(text, list);
    const verdict = policy.shouldPropose(best, { threshold });
    if (!verdict.propose) return null;   // M1 判"否" → 直接丢，不打扰 M2

    return {
      word: best.word,
      score: best.score,
      how: best.how || 'loose',
      degraded: true,
      source: 'loose-screen',
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
          const m2Match = m2MatchOf(out.text, list, minM2);
          // matchAtEnd 用 0 阈值先拿到候选与分数，再用该词自己的 m2 阈值筛
          if (m2Match && !m2Match.ambiguous && m2Match.score < m2ThresholdOf(m2Match.word)) {
            m2Match.matched = false;
          }
          m2 = {
            usable: true,
            text: out.text || '',
            word: m2Match && !m2Match.ambiguous && m2Match.matched !== false ? m2Match.word : null,
            ms: out.ms || null,
          };
        }
      } catch { /* M2 掉了就退化到 M1 */ }
    }

    const verdict = policy.decide({
      word: candidate.word,
      m1Score: candidate.score,
      m1How: candidate.how,
      m2Word: m2.word,
      m2Text: m2.text,
      m2Usable: m2.usable,
      isHandy,
      handyWords: this.deps.handyWords ? this.deps.handyWords() : null,
      threshold,
    });


    // 判成丢弃时，若 M2 根本没给出结果（promise 为空/超时），或候选是缺字命中，
    // 就用门到期时的完整音频补问一次 M2（约 43ms）。只是保证"问了 M2 就真拿到答案"。
    const needRetry = !m2.usable || candidate.degraded;
    if (verdict.action === 'drop' && needRetry && typeof retryAudio === 'function') {
      try {
        const audio2 = retryAudio();
        if (process.env.VK_DEBUG_AUDIO) console.error('[retry] 切片 ' + (audio2.length / 16000).toFixed(2) + 's');
        if (audio2 && audio2.length > 1600) {
          const out2 = await this.deps.m2.confirm(audio2, 1500);
          if (out2 && !out2.timeout && !out2.error) {
            const list = this.deps.words();
            const m2b = m2MatchOf(out2.text, list, threshold);
            const word2 = m2b && !m2b.ambiguous ? m2b.word : null;
            const verdict2 = policy.decide({
              word: candidate.word,
              m1Score: candidate.score,
              m1How: candidate.how,
              m2Word: word2,
              m2Text: out2.text || '',
              m2Usable: true,
              isHandy,
              threshold,
            });
            if (verdict2.action !== 'drop') {
              this.last = { at: Date.now(), candidate, m2: { usable: true, text: out2.text || '', word: word2, ms: out2.ms }, verdict: { ...verdict2, retried: true } };
              return { ...verdict2, retried: true, m2: this.last.m2 };
            }
            m2 = { usable: true, text: out2.text || '', word: word2, ms: out2.ms };
            verdict = verdict2;
          }
        }
      } catch { /* 重判失败就按原判定 */ }
    }

    this.last = { at: Date.now(), candidate, m2, verdict };
    return { ...verdict, m2 };
  }

  state() {
    return { last: this.last, policy: policy.DEFAULT_POLICY };
  }
}

module.exports = { Pipeline, policy };
