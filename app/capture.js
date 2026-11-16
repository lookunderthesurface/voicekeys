// 采集：把"有信息量"的语音段存下来，供之后用强模型（老师）复核。
//
// 规则（2026-11-15 与用户共同定）：
//   存：① 触发了的段（误触发只能从这些里找）
//       ② 最高分落在 [0.40, 0.85) 的段（模糊带：既有"听错的真命令"，也有"相近的无关句"）
//       ③ 有声但转写 < 2 个字的段（说了却没转出来 = 最该看的漏检）
//       ④ 每 20 段随机留 1 段做背景对照（防止只存边界样本导致数据分布偏移）
//   不存：分数 < 0.40 且有正常文本（明显无关）、时长 < 0.3 秒、纯静音
//   上限 100 段，**存满即停**，不做环形覆盖（用户明确否决环形缓冲）。
const fs = require('node:fs');
const path = require('node:path');
const algo = require('./algorithms');
const sampler = algo.sampler;
const sampling = require('./sampling.js');   // 仅用于默认策略的辅助函数

const SR = 16000;
const MAX_SEGMENTS = Number(process.env.VK_CAPTURE_MAX || 100);
const LOW_SCORE = 0.40;
const HIGH_SCORE = 0.85;
const MIN_MS = 300;
const MAX_MS = 6000;      // 15 秒的段既没用又占空间（实测 60 段里 40 段是 12 秒的噪音）
const BACKGROUND_EVERY = 20;
const DIAGNOSTIC_MAX = 40;

class Capture {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.jsonl');
    this.max = MAX_SEGMENTS;
    try { this.max = Number(require('./providers.js').load().captureMax) || MAX_SEGMENTS; } catch { /* 用默认 */ }
    this.enabled = true;
    this.policy = sampling.DEFAULT_POLICY;
    this.report = null;
    this.diagnosticUntil = 0;   // >0 表示诊断模式，到点自动关闭
    this.diagnosticCount = 0;
    this.count = 0;
    this.cache = null;
    this.whyCounts = null;
    this.skipped = 0;
    this.buffer = [];
    this.bufferMs = 0;
    this.voicedMs = 0;
    this.firedWord = null;
    this.lastDropReason = '';
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    this.cache = null;
    this.count = this.list().length;
    // 上次的复核报表落过盘，重启后读回来：否则"哪些词已优化"的判断会退化
    try {
      const rep = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
      if (rep && Array.isArray(rep.rows)) this.report = rep;
    } catch { /* 没有就算了 */ }
  }

  list() {
    if (this.cache) return this.cache;
    try {
      this.cache = fs.readFileSync(this.indexFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  get full() { return this.count >= this.max; }

  countByWhy(why) {
    if (!this.whyCounts) {
      this.whyCounts = {};
      for (const e of this.list()) this.whyCounts[e.why] = (this.whyCounts[e.why] || 0) + 1;
    }
    return this.whyCounts[why] || 0;
  }

  state() {
    const diagLeft = Math.max(0, this.diagnosticUntil - Date.now());
    return {
      diagnosticActive: diagLeft > 0,
      diagnosticLeftMs: diagLeft,
      diagnosticCount: this.diagnosticCount || 0,
      enabled: this.enabled,
      count: this.count,
      max: this.max,
      full: this.full,
      skipped: this.skipped,
      lastDropReason: this.lastDropReason,
      dir: this.dir,
    };
  }

  /** 每 100ms 帧调用：攒当前这句话的音频 */
  pushFrame(frame, rms) {
    if (!this.enabled || this.full) return;
    this.buffer.push(frame);
    this.bufferMs += 100;
    if (rms > 0.03) this.voicedMs += 100;   // 0.02 会把底噪也算成说话，实测这台麦克风底噪约 0.02-0.04
    if (this.bufferMs >= MAX_MS) this.forceFlush();
  }

  /**
   * 取当前这句话的音频（最多 maxMs 毫秒，默认 5 秒）。
   * 确认模型要用它——在静音门里重新听一遍这句话。
   */
  currentAudio(maxMs = 5000) {
    const frames = Math.max(1, Math.floor(maxMs / 100));
    const picked = this.buffer.slice(-frames);
    const total = picked.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const f of picked) { out.set(f, off); off += f.length; }
    return out;
  }

  /** ASR 认出这个词时调用，标记这句话"触发过" */
  markFired(word, text) { this.firedWord = word; if (text) this.firedText = String(text).trim(); }

  /** 一句话结束（ASR endpoint / final）时调用 */
  finish(text, best, opts = {}) {
    // opts.samples：服务器传进来的"这一句话"音频（音量切片）。
    // 用它替代内部缓冲——内部缓冲经常被 ASR 切句切成 6 秒空段（实测 7/11 是废段）。
    const useSamples = opts.samples && opts.samples.length > 1600;
    const segment = {
      buffer: useSamples ? [opts.samples] : this.buffer,
      ms: useSamples ? Math.round((opts.samples.length / 16000) * 1000) : this.bufferMs,
      voicedMs: useSamples ? Math.min(this.voicedMs || Math.round((opts.samples.length / 16000) * 1000), Math.round((opts.samples.length / 16000) * 1000)) : this.voicedMs,
      firedWord: this.firedWord,
      firedBy: opts.firedBy || null,
    };
    this.reset();
    return this.evaluate(text, best, segment);
  }

  forceFlush() {
    // 超过 6 秒还没等到句尾：这类段既没有文本也没有明确边界，保存下来只会变成废数据。
    const ms = this.bufferMs;
    const voiced = this.voicedMs;
    this.reset();
    this.skipped = (this.skipped || 0) + 1;
    this.lastDropReason = '超过 ' + Math.round(ms / 1000) + ' 秒没有句尾，丢弃（有声 ' + voiced + 'ms）';
    return { saved: false, why: 'forceFlush' };
  }

  /**
   * 记录一次"判断素材"。
   * @param {object} d
   * @param {Float32Array} d.audio  交给 M2 的那段音频（fast 路径则为当时的说话音频）
   * @param {string} d.word         候选词
   * @param {number} d.m1Score      M1 的匹配分
   * @param {string} d.m1How        M1 的匹配方式
   * @param {string} [d.m2Text]     M2 听到的原文
   * @param {string} [d.m2Word]     M2 匹配到的词
   * @param {string} d.verdict      最终判定（agree/m2-decides/m2-veto/...）
   * @param {string} d.path         'fast' | 'm2'
   */
  recordDecision(d) {
    // 用户要的是 5 秒素材（触发前 4 秒 + 触发后 1 秒）。
    // 之前这里是 4000，实际只存了 4 秒，段尾经常被截掉 ——
    // 多遍录音里"最后一段后面 0.00s 音频"就是这么来的。
    const MAX_DECISION_MS = 5000;
    if (!d || !d.audio || !d.audio.length) return { saved: false, why: 'no-audio' };
    if (d.audio.length < 3200) return { saved: false, why: 'too-short' };

    const cap = Math.min(d.audio.length, Math.round((MAX_DECISION_MS / 1000) * 16000));
    const pcm = cap === d.audio.length ? d.audio : d.audio.subarray(d.audio.length - cap);

    let voiced = 0;
    for (let i = 0; i + 1600 <= pcm.length; i += 1600) {
      let ps = 0;
      for (let j = 0; j < 1600; j += 1) ps += pcm[i + j] * pcm[i + j];
      if (Math.sqrt(ps / 1600) > 0.03) voiced += 1;
    }

    // id 必须与"条数"脱钩：index 被清理后条数会变小，再用条数当 id 会覆盖旧录音。
    const existing = this.list();
    this.count = existing.length;
    const maxId = existing.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    const id = String(maxId + 1).padStart(4, '0');
    const file = `seg-${id}.wav`;
    try {
      this.writeWav(path.join(this.dir, file), [pcm]);
    } catch (e) {
      return { saved: false, why: 'write-failed' };
    }

    const entry = {
      id,
      at: new Date().toISOString(),
      file,
      ms: Math.round((pcm.length / 16000) * 1000),
      voicedMs: voiced * 100,
      why: d.path === 'fast' ? 'fast' : 'm2',
      ourText: d.word || '',
      bestScore: d.m1Score,
      m1How: d.m1How,
      m2Text: d.m2Text || '',
      m2Word: d.m2Word || '',
      verdict: d.verdict || '',
      // recordDecision 只在真要执行时被调用（server 的 captureAfterFire），所以恒为 true
      fired: true,
    };
    try {
      fs.appendFileSync(this.indexFile, JSON.stringify(entry) + '\n');
    } catch {
      return { saved: false, why: 'index-failed' };
    }
    return { saved: true, entry };
  }

  reset() {
    this.buffer = [];
    this.bufferMs = 0;
    this.voicedMs = 0;
    this.firedWord = null;
    this.firedText = null;
  }

  /** 判定这一段该不该存；该存就落盘并写索引 */
  /** 给采样策略提供"每个词认得多准"的统计（校准后由 server 注入报表） */
  stats() {
    if (!this._stats || this._statsAt !== this.count) {
      this._stats = sampling.wordStats(this.list(), this.report);
      this._statsAt = this.count;
    }
    return this._stats;
  }

  /** 索引文件被外部改写（清洗）后重新读一遍 */
  /** 被确认模型否决：这条记录不应该算作"我们触发了" */
  markSuppressed() {
    const last = this.cache && this.cache[this.cache.length - 1];
    if (!last) return;
    last.fired = false;
    last.suppressed = true;
    last.why = 'suppressed';
    try {
      const lines = fs.readFileSync(this.indexFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length) {
        const obj = JSON.parse(lines[lines.length - 1]);
        obj.fired = false;
        obj.suppressed = true;
        obj.why = 'suppressed';
        lines[lines.length - 1] = JSON.stringify(obj);
        fs.writeFileSync(this.indexFile, lines.join('\n') + '\n');
      }
    } catch { /* ignore */ }
  }

  /** 被确认模型改判：更新记录里的词 */
  remarkWord(word) {
    const last = this.cache && this.cache[this.cache.length - 1];
    if (!last) return;
    last.firedWord = word;
    try {
      const lines = fs.readFileSync(this.indexFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length) {
        const obj = JSON.parse(lines[lines.length - 1]);
        obj.firedWord = word;
        lines[lines.length - 1] = JSON.stringify(obj);
        fs.writeFileSync(this.indexFile, lines.join('\n') + '\n');
      }
    } catch { /* ignore */ }
  }

  reload() {
    try { this.max = Number(require('./providers.js').load().captureMax) || this.max; } catch { /* ignore */ }
    this.cache = null;
    this.whyCounts = null;
    this.count = this.list().length;
    this._stats = null;
    return this.state();
  }

  setReport(report) {
    this.report = report || null;
    this._stats = null;
  }

  /** 已优化（认得很稳）的词，界面要能看见 */
  optimized() {
    return [...sampling.optimizedWords(this.stats(), this.policy)];
  }

  /**
   * 决定这一段要不要存、以什么理由存。返回 null 表示不存。
   * 规则本身在 sampling.js（独立模块），这里只负责把上下文递过去。
   */
  decide(seg, textLen, score, best) {
    const diag = this.diagnosticUntil > Date.now();
    const res = sampler.decide(
      {
        text: seg.text || '',
        score,
        fired: Boolean(seg.firedWord),
        voicedMs: seg.voicedMs,
        ms: seg.ms,
        bestWord: best ? best.word : '',
      },
      {
        entries: this.list(),
        stats: this.stats(),
        policy: this.policy,
        diagnostic: diag && (this.diagnosticCount || 0) < DIAGNOSTIC_MAX,
      },
    );
    this.lastValue = res.value;
    this.lastReason = res.reason;
    return res.keep ? res.reason : null;
  }

  evaluate(text, best, seg) {
    if (!this.enabled) return { saved: false, reason: 'disabled' };
    if (this.full) { this.skipped += 1; this.lastDropReason = '已存满'; return { saved: false, reason: 'full' }; }
    if (seg.ms < MIN_MS) { this.skipped += 1; this.lastDropReason = '太短'; return { saved: false, reason: 'too-short' }; }
    if (seg.voicedMs < 200) { this.skipped += 1; this.lastDropReason = '没声音'; return { saved: false, reason: 'no-voice' }; }

    const score = best ? best.score : 0;
    const textLen = (text || '').replace(/[\s，。,.!！?？]/g, '').length;
    const why = this.decide({ ...seg, text: text || '' }, textLen, score, best);

    if (!why) {
      this.skipped += 1;
      this.lastDropReason = `分数 ${score.toFixed(2)}，无关`;
      return { saved: false, reason: 'unrelated' };
    }
    if (why === 'diagnostic') this.diagnosticCount = (this.diagnosticCount || 0) + 1;

    const existing = this.list();
    const maxId = existing.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    const id = String(maxId + 1).padStart(4, '0');
    const file = path.join(this.dir, `seg-${id}.wav`);
    try {
      this.writeWav(file, seg.buffer);
    } catch (e) {
      this.lastDropReason = '写文件失败: ' + e.message;
      return { saved: false, reason: 'write-failed' };
    }

    const entry = {
      id,
      file: path.basename(file),
      at: new Date().toISOString(),
      ms: seg.ms,
      voicedMs: seg.voicedMs,
      ourText: (seg.firedWord && this.firedText) ? this.firedText : (text || ''),
      bestWord: best ? best.word : '',
      bestScore: Number(score.toFixed(3)),
      how: best ? best.how : '',
      fired: Boolean(seg.firedWord),
      firedWord: seg.firedWord || '',
      why,
    };
    try { fs.appendFileSync(this.indexFile, JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
    if (this.cache) this.cache.push(entry);
    if (this.whyCounts) this.whyCounts[why] = (this.whyCounts[why] || 0) + 1;
    this.count += 1;
    return { saved: true, entry };
  }

  writeWav(file, frames) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const buf = Buffer.alloc(44 + total * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + total * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(total * 2, 40);
    let off = 44;
    for (const f of frames) {
      for (let i = 0; i < f.length; i += 1) {
        const v = Math.max(-1, Math.min(1, f[i]));
        buf.writeInt16LE(Math.round(v * 32767), off);
        off += 2;
      }
    }
    fs.writeFileSync(file, buf);
  }

  startDiagnostic(minutes = 10) {
    this.diagnosticUntil = Date.now() + Math.max(1, Math.min(60, minutes)) * 60000;
    this.diagnosticCount = 0;
    return this.state();
  }

  stopDiagnostic() {
    this.diagnosticUntil = 0;
    return this.state();
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) this.reset();
    return this.state();
  }

  clear() {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.wav') || f.endsWith('.jsonl') || f.endsWith('.report.json')) {
          fs.unlinkSync(path.join(this.dir, f));
        }
      }
    } catch { /* ignore */ }
    this.count = 0;
    this.cache = null;
    this.whyCounts = null;
    this.skipped = 0;
    this.lastDropReason = '';
    this.reset();
    return this.state();
  }
}

module.exports = { Capture, MAX_SEGMENTS, LOW_SCORE, HIGH_SCORE };
