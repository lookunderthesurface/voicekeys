// Audio input: the system microphone, or a WAV file for self-tests.
//
// Both sources expose the same `read()` that resolves to one 100 ms block of float32 audio,
// so the loop has no idea (and no branch) whether a human or a recording is speaking.
//
// Capture uses PvRecorder, which ships prebuilt binaries for Windows / macOS / Linux, so a
// fresh install needs no compiler and no Python.
const fs = require('fs');
const path = require('path');
const { PvRecorder } = require('@picovoice/pvrecorder-node');

const { BLOCK, BLOCK_SECONDS, FRAME, SR } = require('./config.cjs');
const protocol = require('./protocol.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toFloat32(frame) {
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) out[i] = frame[i] / 32768;
  return out;
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function rms(block) {
  if (!block || !block.length) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
  return Math.sqrt(sum / block.length);
}

class AudioSource {
  constructor() {
    this.pending = new Float32Array(0);
    this.stopped = false;
  }

  async read() {
    return null;
  }

  stop() {
    this.stopped = true;
  }

  /** Throw away buffered audio (blocks from before a capture started). */
  drain() {
    this.pending = new Float32Array(0);
  }
}

class MicrophoneSource extends AudioSource {
  constructor(device) {
    super();
    this.recorder = null;
    this.deviceIndex = MicrophoneSource.resolveDevice(device);
  }

  /** Resolve a device index or name fragment against the recorder's device list. */
  static resolveDevice(spec) {
    const wanted = (spec || '').trim();
    if (!wanted) return -1;
    if (/^\d+$/.test(wanted)) return Number(wanted);
    let devices = [];
    try {
      devices = PvRecorder.getAvailableDevices() || [];
    } catch (error) {
      protocol.diag({ reason: 'device-query-failed', error: String(error && error.message) });
      return -1;
    }
    const index = devices.findIndex((name) => String(name).toLowerCase().includes(wanted.toLowerCase()));
    if (index < 0) {
      protocol.diag({ reason: 'device-not-found', spec: wanted, devices });
      return -1;
    }
    protocol.emit(protocol.INFO, `input device ${index}: ${devices[index]}`);
    return index;
  }

  async start() {
    // The system default device is what the operator expects, so it is tried first.
    await this.open(this.deviceIndex);
    protocol.emit(protocol.INFO, `input device: ${this.deviceName()}`);

    // ...but on Windows the "default" endpoint can be a switched-off headset, which records
    // pure digital silence. A real microphone always has some noise floor, so all-zero frames
    // mean "this endpoint is dead", not "the room is quiet". Only then look elsewhere.
    if (this.deviceIndex < 0 && (await this.isDigitalSilence())) {
      const fallback = await this.findLiveDevice();
      if (fallback >= 0) {
        this.close();
        await this.open(fallback);
        protocol.emit(protocol.INFO, `system default was silent, switched to: ${this.deviceName()}`);
      } else {
        protocol.emit(protocol.INFO, 'every microphone reads digital silence; keeping the system default');
      }
    }
  }

  async open(deviceIndex) {
    this.deviceIndex = deviceIndex;
    this.recorder = new PvRecorder(FRAME, deviceIndex, 120);
    this.recorder.start();
    if (this.recorder.sampleRate !== SR) {
      throw new Error(`recorder sample rate ${this.recorder.sampleRate}, expected ${SR}`);
    }
  }

  close() {
    try { this.recorder.stop(); } catch { /* already stopped */ }
    try { this.recorder.release(); } catch { /* ignore */ }
    this.recorder = null;
  }

  /** Read ~2 s and report whether every sample was exactly zero. */
  async isDigitalSilence() {
    const frames = Math.ceil((2 * SR) / FRAME);
    let loudest = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      this.pending = concat(this.pending, toFloat32(await this.recorder.read()));
      for (let i = 0; i < this.pending.length; i += 1) loudest = Math.max(loudest, Math.abs(this.pending[i]));
    }
    this.drain();
    return loudest === 0;
  }

  /** First device that produces any non-zero sample at all. */
  async findLiveDevice() {
    let devices = [];
    try {
      devices = PvRecorder.getAvailableDevices() || [];
    } catch {
      return -1;
    }
    for (let index = 0; index < devices.length; index += 1) {
      if (index === this.deviceIndex) continue;
      let recorder = null;
      try {
        recorder = new PvRecorder(FRAME, index, 20);
        recorder.start();
        let loudest = 0;
        for (let frame = 0; frame < 20 && loudest === 0; frame += 1) {
          const samples = await recorder.read();
          for (let i = 0; i < samples.length; i += 1) loudest = Math.max(loudest, Math.abs(samples[i]));
        }
        if (loudest > 0) return index;
      } catch { /* try the next device */ } finally {
        try { recorder.stop(); } catch { /* not started */ }
        try { recorder.release(); } catch { /* ignore */ }
      }
    }
    return -1;
  }

  deviceName() {
    // The recorder does not tell us which endpoint the default resolves to, so do not guess:
    // naming the first entry in the list is how a wrong claim got into the log before.
    try {
      const devices = PvRecorder.getAvailableDevices() || [];
      if (this.deviceIndex < 0) return 'system default';
      return devices[this.deviceIndex] || `index ${this.deviceIndex}`;
    } catch {
      return this.deviceIndex < 0 ? 'system default' : `index ${this.deviceIndex}`;
    }
  }

  async read() {
    while (!this.stopped && this.pending.length < BLOCK) {
      const frame = await this.recorder.read();
      this.pending = concat(this.pending, toFloat32(frame));
    }
    if (this.stopped) return null;
    const block = this.pending.slice(0, BLOCK);
    this.pending = this.pending.slice(BLOCK);
    return block;
  }

  stop() {
    super.stop();
    try { this.recorder.stop(); } catch { /* already stopped */ }
    try { this.recorder.release(); } catch { /* ignore */ }
    this.recorder = null;
  }
}

class WavSource extends AudioSource {
  /** Real-time paced replay: end-of-turn detection depends on wall-clock silence. */
  constructor(file) {
    super();
    this.file = file;
    this.audio = null;
    this.offset = 0;
  }

  async start() {
    this.audio = readWav(this.file);
    protocol.emit(protocol.INFO, `wav mode: ${path.basename(this.file)}, ${(this.audio.length / SR).toFixed(2)}s`);
  }

  async read() {
    await sleep(BLOCK_SECONDS * 1000);
    if (this.stopped) return null;
    if (this.offset < this.audio.length) {
      const block = new Float32Array(BLOCK);
      const slice = this.audio.subarray(this.offset, Math.min(this.offset + BLOCK, this.audio.length));
      block.set(slice);
      this.offset += BLOCK;
      return block;
    }
    // Keep pushing silence, exactly like a live microphone would, so an utterance that
    // reaches the end of the file can still be closed by its send word or by a timeout.
    return new Float32Array(BLOCK);
  }

  drain() {
    // Only drop what is still unread in the current block; the file position keeps moving.
  }
}

/** Minimal 16-bit PCM WAV reader (mono or stereo, 16 kHz). */
function readWav(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a WAV file`);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw new Error(`${file}: missing fmt or data chunk`);
  if (format.bits !== 16) throw new Error(`${file}: need 16-bit PCM, got ${format.bits}`);
  if (format.rate !== SR) throw new Error(`${file}: need ${SR} Hz, got ${format.rate}`);
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768;
  if (format.channels > 1) {
    const mono = new Float32Array(samples.length / format.channels);
    for (let i = 0; i < mono.length; i += 1) {
      let sum = 0;
      for (let c = 0; c < format.channels; c += 1) sum += samples[i * format.channels + c];
      mono[i] = sum / format.channels;
    }
    return mono;
  }
  return samples;
}

function makeSource(settings) {
  return settings.wav ? new WavSource(settings.wav) : new MicrophoneSource(settings.device);
}

module.exports = { AudioSource, MicrophoneSource, WavSource, makeSource, readWav, rms, sleep };
