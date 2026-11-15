// 触发层：KWS 命中 → 等一段静音 → 交给执行器。
//
// 三类词：
//   唤醒词（听我说）  → 立刻执行（pause 0），用来开 Handy 录音
//   结束词（over）    → 等 600ms 静音，用来停 Handy 录音
//   命令词（声音大一点…）→ 等 1000ms 静音，且必须"从安静里冒出来"（首部门）
const SR = 16000;
const VOICE_RMS = 0.02;

class Trigger {
  constructor({
    wakeWords = [],
    endWords = [],
    words = [],
    pauseMs = 1000,
    wakePauseMs = 0,
    endPauseMs = 600,
    maxLeadMs = 900,
    onFire = () => {},
    onWake = () => {},
    onEnd = () => {},
    onEvent = () => {},
  }) {
    this.wakeWords = new Set(wakeWords);
    this.endWords = new Set(endWords);
    this.words = words;
    this.pauseMs = pauseMs;
    this.wakePauseMs = wakePauseMs;
    this.endPauseMs = endPauseMs;
    this.maxLeadMs = maxLeadMs;
    this.meta = {};   // { word: { pauseMs, noLead } }
    this.onFire = onFire;
    this.onWake = onWake;
    this.onEnd = onEnd;
    this.onEvent = onEvent;
    this.pending = null;
    this.voiceRunMs = 0;
    this.lastFireAt = new Map();
    this.cooldownMs = 800;
  }


  pauseFor(word) {
    const m = this.meta[word];
    if (m && typeof m.pauseMs === 'number') return m.pauseMs;
    return this.pauseMs;
  }

  /** 每 100ms 喂一块音频：只负责"是否在说话"与结算待确认命令（识别在 ASR 子进程里做） */
  feedVoice(samples, now = Date.now()) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const voice = rms > VOICE_RMS;
    if (voice) this.lastVoiceAt = now;
    this.voiceRunMs = voice ? this.voiceRunMs + (samples.length / SR) * 1000 : 0;

    // 命中窗口内继续检测到说话 → 判定"还在说"，丢弃
    if (this.pending && now > this.pending.graceUntil && voice && !this.pending.ignoreNoisy) this.pending.noisy = true;

    // 静音确认到期
    if (this.pending && now - this.pending.at >= this.pending.pause) {
      const p = this.pending;
      this.pending = null;
      this.silenceBeforeFireMs = this.lastVoiceAt ? Math.max(0, now - this.lastVoiceAt) : null;
      if (p.noisy) {
        this.onEvent({ type: 'drop', word: p.word, reason: 'kept talking' });
      } else {
        // 这里只是静音门到期，还不是触发：M2 的裁决随后才到，可能是否决。
        this.onEvent({ type: 'gate', word: p.word });
        try {
          if (this.wakeWords.has(p.word)) this.onWake(p.word);
          else if (this.endWords.has(p.word)) this.onEnd(p.word);
          else this.onFire(p.word);
        } catch (e) {
          this.onEvent({ type: 'error', message: String(e && e.message) });
        }
      }
    }

  }


  /** 取消正在等待静音门的候选（门内又出现新文字时调用） */
  cancelPending(reason = 'cancelled') {
    if (!this.pending) return null;
    const word = this.pending.word;
    this.pending = null;
    this.onEvent({ type: 'drop', word, reason });
    return word;
  }

  queue(word, now = Date.now()) {
    // 首部门：除非这个词被标记为 noLead（唤醒/结束词本来就出现在连续说话里）
    const meta = this.meta[word];
    if (!(meta && meta.noLead)) {
      if (this.maxLeadMs > 0 && this.voiceRunMs > this.maxLeadMs) {
        this.onEvent({ type: 'ignored', word, reason: `already talking ${Math.round(this.voiceRunMs)}ms` });
        return;
      }
    }
    const last = this.lastFireAt.get(word) || 0;
    if (now - last < this.cooldownMs) {
      this.onEvent({ type: 'ignored', word, reason: 'cooldown' });
      return;
    }
    this.lastFireAt.set(word, now);
    const pause = this.pauseFor(word);
    this.pending = { word, at: now, graceUntil: now + 250, noisy: false, pause, ignoreNoisy: Boolean(meta && meta.ignoreNoisy) };
    this.onEvent({ type: 'heard', word, waitMs: pause });
  }
}

module.exports = { Trigger, SR };
