// 音频源：真实麦克风，或 WAV（用于自测，不需要人说话）
const fs = require('node:fs');
const path = require('node:path');

const PATHS = require('./paths.js');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || PATHS.pluginRoot();
const { PvRecorder } = require(path.join(PLUGIN, 'node_modules', '@picovoice', 'pvrecorder-node'));
const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));

const SR = 16000;
const FRAME = 1600;   // 100ms

/** 有些设备（虚拟/被禁用）只会返回全 0；启动时挨个试，挑第一个真正有数据的 */
async function findLiveDevice() {
  const devices = PvRecorder.getAvailableDevices() || [];
  for (let i = 0; i < devices.length; i += 1) {
    let rec;
    try {
      rec = new PvRecorder(FRAME, i, 100);
      rec.start();
      let peak = 0;
      for (let k = 0; k < 5; k += 1) {
        const f = await rec.read();
        for (let j = 0; j < f.length; j += 1) peak = Math.max(peak, Math.abs(f[j]));
      }
      if (peak > 0) { await new Promise((r) => setTimeout(r, 350)); return { index: i, name: devices[i], peak }; }
    } catch {
      /* 打不开就试下一个 */
    } finally {
      try { rec.stop(); } catch { /* ignore */ }
      try { rec.release(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { index: 0, name: devices[0] || '(none)', peak: 0 };
}

class MicSource {
  constructor(deviceIndex = 0) {
    this.deviceIndex = deviceIndex;
    this.recorder = null;
  }

  static devices() {
    try { return PvRecorder.getAvailableDevices() || []; } catch { return []; }
  }

  start() {
    this.recorder = new PvRecorder(FRAME, this.deviceIndex, 200);
    this.recorder.start();
  }

  /** @returns {Promise<Float32Array|null>} */
  async read() {
    if (!this.recorder) return null;
    const frame = await this.recorder.read();
    if (!frame || !frame.length) return null;
    const out = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) out[i] = frame[i] / 32768;
    return out;
  }

  stop() {
    if (!this.recorder) return;
    try { this.recorder.stop(); } catch { /* ignore */ }
    try { this.recorder.release(); } catch { /* ignore */ }
    this.recorder = null;
  }
}

/** 把 WAV 按实时节奏吐出来，模拟麦克风 */
class WavSource {
  constructor(file, { realtime = true, loop = false } = {}) {
    this.file = file;
    this.realtime = realtime;
    this.loop = loop;
    this.samples = readWav(file);
    this.offset = 0;
    this.stopped = false;
  }

  start() {
    this.startedAt = Date.now();
  }

  async read() {
    if (this.stopped) return null;
    if (this.offset >= this.samples.length) {
      if (!this.loop) return null;
      this.offset = 0;
    }
    const chunk = this.samples.subarray(this.offset, Math.min(this.offset + FRAME, this.samples.length));
    this.offset += chunk.length;
    if (this.realtime) {
      const due = this.startedAt + (this.offset / SR) * 1000;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    // 不足一帧时补零，保证帧长一致
    if (chunk.length === FRAME) return chunk;
    const padded = new Float32Array(FRAME);
    padded.set(chunk, 0);
    return padded;
  }

  stop() {
    this.stopped = true;
  }
}

function makeSource(spec, deviceIndex = 0) {
  if (spec && spec.startsWith('wav:')) {
    const file = spec.slice(4);
    if (!fs.existsSync(file)) throw new Error('WAV 不存在: ' + file);
    return new WavSource(file, { realtime: true });
  }
  return new MicSource(deviceIndex);
}

module.exports = { MicSource, WavSource, makeSource, findLiveDevice, SR, FRAME };
