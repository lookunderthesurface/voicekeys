// 确认模型的管理器（主进程侧）
//
// 职责：
//   · 按需拉起 app/confirmer-worker.js（加载 850ms），进程内常驻
//   · 发请求、按 id 收结果
//   · 空闲 VK_CONFIRM_IDLE_MS（默认 5 分钟）没活干就让它退出，把 190MB 还回去
//   · 提前预热：ASR 一吐字就调 preload()，等真正要用时基本已就绪
const path = require('node:path');
const { spawn } = require('node:child_process');

const IDLE_MS = Number(process.env.VK_CONFIRM_IDLE_MS || 15 * 60 * 1000);   // 用户要求：空转 15 分钟才卸载

class Confirmer {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.loadMs = null;
    this.lastUsedAt = 0;
    this.idleTimer = null;
    this.stats = { requests: 0, timeouts: 0, errors: 0, unloaded: 0 };
  }

  start() {
    if (this.proc) return;
    this.ready = false;
    this.buf = '';
    this.proc = spawn(process.execPath, [path.join(__dirname, 'confirmer-worker.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.on('data', (c) => this.onData(c));
    this.proc.stderr.on('data', (c) => {
      const s = String(c).trim();
      if (s) this.log('确认模型 stderr: ' + s.slice(0, 160));
    });
    this.proc.on('exit', () => {
      this.proc = null;
      this.ready = false;
      for (const [, p] of this.pending) p.resolve(null);
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'ready') {
        this.ready = true;
        this.loadMs = msg.loadMs;
        this.log('确认模型就绪（' + msg.model + '，加载 ' + msg.loadMs + 'ms，' + msg.threads + ' 线程）');
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.type === 'result') p.resolve({ text: msg.text, ms: msg.ms });
      else { this.stats.errors += 1; p.resolve(null); }
    }
  }

  /** 预热：ASR 一出字就调，把 850ms 加载藏在说话过程中 */
  preload() {
    if (this.proc) return;
    this.start();
  }

  /**
   * 请求确认：把这段音频交给非流式模型重新识别。
   * @param {Float32Array} samples 16k mono
   * @param {number} timeoutMs 超时就当没确认（用流式结果继续）
   */
  confirm(samples, timeoutMs = 400) {
    // 静音片段直接返回：喂给 ONNX 会抛 "Non-zero status code returned while running Reshape"，
    // 只是刷日志、没有意义。阈值 0.005 ≈ 人耳听不见。
    let peak = 0;
    for (let i = 0; i < samples.length; i += 16) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
    if (peak < 0.005) return Promise.resolve({ text: '', ms: 0, silent: true });
    this.start();
    this.lastUsedAt = Date.now();
    this.stats.requests += 1;
    this.scheduleIdleCheck();

    const id = this.nextId;
    this.nextId += 1;
    const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.stats.timeouts += 1;
          resolve({ timeout: true });
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v ? { ...v } : { error: true }); },
      });

      try {
        this.proc.stdin.write(JSON.stringify({ type: 'audio', id, pcm }) + '\n');
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        this.stats.errors += 1;
        resolve({ error: true });
      }
    });
  }

  scheduleIdleCheck() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.maybeUnload(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  maybeUnload() {
    if (!this.proc) return;
    if (Date.now() - this.lastUsedAt < IDLE_MS) { this.scheduleIdleCheck(); return; }
    this.stop('空闲超时');
  }

  stop(reason = 'stop') {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.proc) return;
    try { this.proc.stdin.write(JSON.stringify({ type: 'quit' }) + '\n'); } catch { /* ignore */ }
    const p = this.proc;
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 500).unref?.();
    this.proc = null;
    this.ready = false;
    this.stats.unloaded += 1;
    this.log('确认模型已退出（' + reason + '）');
  }

  state() {
    return {
      running: Boolean(this.proc),
      ready: this.ready,
      loadMs: this.loadMs,
      idleMs: IDLE_MS,
      stats: this.stats,
    };
  }
}

module.exports = { Confirmer };
