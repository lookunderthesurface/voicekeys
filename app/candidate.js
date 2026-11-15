// 候选跟踪：把"半句里出现的词"和"真正说完了命令"区分开。
//
// 背景（2026-11-15 事故）：
//   ASR 是流式的，你说「静音门的时间里面」，它先吐出「静音」——我们就精确命中并触发了。
//   你说「这样很合理啊」，它先吐出「这样」——前缀匹配到同义词「这样听视频」@0.85，也触发了。
//   结果就是：一句话里的半句被当成命令执行（当场把视频播了）。
//
// 规则（配合静音门）：
//   ① 只有**这句话以它结尾**的词才算候选（matchAtEnd）
//   ② 候选要**稳定 300ms 不再变**才算说完（文本一变就作废）
//   ③ 稳定之后才进静音门（等 pauseMs 的静音），门内跑确认模型
//   ④ 门内如果又冒出新文字（说明还在说），候选再次作废

const DEFAULT_STABLE_MS = Number(process.env.VK_CANDIDATE_STABLE_MS || 300);

class CandidateTracker {
  constructor({ stableMs = DEFAULT_STABLE_MS } = {}) {
    this.stableMs = stableMs;
    this.candidate = null;   // { word, text, at }
    this.lastEvent = null;
  }

  /** ASR 每吐一次文本就调用；返回当前候选（可能为 null） */
  update(text, match, now = Date.now()) {
    if (!match || !match.word) {
      if (this.candidate) {
        this.lastEvent = { type: 'dropped', reason: '文本已不再是命令', word: this.candidate.word };
        this.candidate = null;
      }
      return null;
    }
    // 同一个词、且文本没变化 → 保持原时间戳（这才是"稳定"）
    if (this.candidate && this.candidate.word === match.word && this.candidate.text === text) {
      return this.candidate;
    }
    // 文本变了（哪怕还是同一个词），重新计时
    this.candidate = { word: match.word, text, at: now, score: match.score, how: match.how };
    this.lastEvent = { type: 'candidate', word: match.word, score: match.score };
    return this.candidate;
  }

  /** 每 100ms 的音频循环里调用；到点返回 true（只返回一次） */
  due(now = Date.now()) {
    if (!this.candidate) return false;
    if (now - this.candidate.at < this.stableMs) return false;
    const word = this.candidate.word;
    this.candidate = null;
    this.lastEvent = { type: 'ready', word };
    return word;
  }

  /** 静音门里又来了新文本：作废候选 */
  invalidate(reason = 'text changed') {
    if (!this.candidate) return null;
    const word = this.candidate.word;
    this.candidate = null;
    this.lastEvent = { type: 'dropped', reason, word };
    return word;
  }

  state() {
    return {
      waitingForStable: Boolean(this.candidate),
      candidateWord: this.candidate ? this.candidate.word : null,
      stableMs: this.stableMs,
      lastEvent: this.lastEvent,
    };
  }
}

module.exports = { CandidateTracker, DEFAULT_STABLE_MS };
