// 确认模型的常驻进程：非流式 paraformer（80MB，8 线程，CPU）
//
// 协议（一行 JSON 来回）：
//   收：{"id":1,"pcm":"<base64 Float32 16k mono>"}
//   回：{"type":"ready","loadMs":850}
//       {"type":"result","id":1,"text":"暂停视频","ms":43}
//       {"type":"error","id":1,"message":"..."}
//
// 为什么单独一个进程：
//   · 80MB 模型 + ONNX 会话约 190MB，放主进程会一起承担 OOM 风险
//   · 解码时是同步计算，放主进程会卡住音频循环
//   · 空闲 5 分钟由上层发 quit，进程退出、内存还回去
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const PATHS = require('./paths.js');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || PATHS.pluginRoot();
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));

const MODEL_DIR = process.env.VK_CONFIRM_MODEL || path.join(
  require('./config.js').DIRS.models, 'asr', 'sherpa-onnx-paraformer-zh-small-2024-03-09',
);
const THREADS = Number(process.env.VK_CONFIRM_THREADS || 8);

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let rec = null;
let loadMs = null;

function ensureLoaded() {
  if (rec) return loadMs;
  const t0 = Date.now();
  rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: { model: path.join(MODEL_DIR, 'model.int8.onnx') },
      tokens: path.join(MODEL_DIR, 'tokens.txt'),
      numThreads: THREADS,
      provider: 'cpu',
      debug: 0,
    },
  });
  loadMs = Date.now() - t0;
  return loadMs;
}

emit({ type: 'ready', loadMs: ensureLoaded(), threads: THREADS, model: path.basename(MODEL_DIR) });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'quit') { process.exit(0); return; }
  if (msg.type !== 'audio') return;

  try {
    const buf = Buffer.from(msg.pcm || '', 'base64');
    const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const t0 = Date.now();
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: 16000, samples });
    rec.decode(st);
    const text = (rec.getResult(st).text || '').trim();
    emit({ type: 'result', id: msg.id, text, ms: Date.now() - t0 });
  } catch (e) {
    emit({ type: 'error', id: msg.id, message: String(e && e.message).slice(0, 200) });
  }
});
rl.on('close', () => process.exit(0));
