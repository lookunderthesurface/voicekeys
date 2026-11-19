// ASR 子进程：把麦克风帧转成文字，用 JSON 行回给主进程。
//
// 为什么要独立进程：
//   1) 可以把整个进程的 CPU 亲和性钉在 E 核（小核）上，绝不抢大核
//   2) ONNX Runtime 的线程池在自己的进程里，崩了不影响音频采集
//
// 协议（stdin/stdout 都是行文本）：
//   输入  {"type":"audio","samples":"<base64 float32 LE>"}
//        {"type":"reset"}      清空当前流（一句话结束）
//        {"type":"flush"}      输入结束，吐出最终结果
//        {"type":"quit"}
//   输出  {"type":"ready","loadMs":123}
//        {"type":"text","text":"把声音","final":false}
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

const PATHS = require('./paths.js');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || PATHS.pluginRoot();
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));

const SR = 16000;
const ASR_ROOT = path.join(require('./config.js').DIRS.models, 'asr');
// 2026-11-20：换用 zipformer-large（multi_zh_hans，2025-06-30），旧的 14M 留作回滚
const DEFAULT_MODEL_DIRS = [
  'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
  'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
];
function defaultModelDir() {
  for (const name of DEFAULT_MODEL_DIRS) {
    const p = path.join(ASR_ROOT, name);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return path.join(ASR_ROOT, DEFAULT_MODEL_DIRS[0]);
}
const MODEL_DIR = process.env.VK_ASR_DIR || defaultModelDir();

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function pickModel(dir) {
  // 兼容两种文件命名：
  //   新模型：encoder.int8.onnx / decoder.onnx / joiner.int8.onnx
  //   旧模型：encoder-epoch-99-avg-1.int8.onnx / ...
  const pick = (names) => names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  const encoder = pick(['encoder.int8.onnx', 'encoder.onnx', 'encoder-epoch-99-avg-1.int8.onnx', 'encoder-epoch-99-avg-1.onnx']);
  const decoder = pick(['decoder.int8.onnx', 'decoder.onnx', 'decoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx']);
  const joiner = pick(['joiner.int8.onnx', 'joiner.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'joiner-epoch-99-avg-1.onnx']);
  if (!encoder || !decoder || !joiner) throw new Error('模型文件缺失: ' + dir);
  return {
    useInt8: /\.int8\.onnx$/.test(encoder),
    transducer: { encoder, decoder, joiner },
    tokens: path.join(dir, 'tokens.txt'),
  };
}

let recognizer = null;
let stream = null;
let lastText = '';

function newStream() {
  if (!recognizer) return;
  stream = recognizer.createStream();
  lastText = '';
}

function init() {
  const t0 = Date.now();
  const picked = pickModel(MODEL_DIR);
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: picked.transducer,
      tokens: picked.tokens,
      // 单线程！ONNX Runtime 的线程池空闲时会自旋：实测 2 线程 = 200% 单核、4 线程 = 574%，
      // 1 线程只要 1.3%（14M 模型每次解码本来就只有几毫秒，多线程没有收益）
      numThreads: Number(process.env.VK_ASR_THREADS || 1),
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,          // 端点检测：一句话说完自己收尾
    rule1MinTrailingSilence: 1.2,  // 静音 1.2 秒判定句尾
    rule2MinTrailingSilence: 0.8,
    rule3MinUtteranceLength: 20,
  });
  newStream();
  emit({ type: 'ready', loadMs: Date.now() - t0, int8: picked.useInt8, model: path.basename(MODEL_DIR) });
}

function decodeAvailable() {
  if (!recognizer || !stream) return;
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = (recognizer.getResult(stream).text || '');
  if (text !== lastText) {
    lastText = text;
    emit({ type: 'text', text, final: false });
  }
}

function handleAudio(b64) {
  if (!stream) return;
  const buf = Buffer.from(b64, 'base64');
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  stream.acceptWaveform({ sampleRate: SR, samples });
  decodeAvailable();
  // 端点检测命中（一句话结束）→ 吐出 final 并自动开新流
  if (recognizer && recognizer.isEndpoint(stream)) {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text || '');
    if (text) emit({ type: 'text', text, final: true });
    recognizer.reset(stream);
    lastText = '';
  }
}

function main() {
  init();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'audio') handleAudio(msg.samples);
    else if (msg.type === 'reset') { if (recognizer && stream) recognizer.reset(stream); lastText = ''; }
    else if (msg.type === 'flush') {
      if (stream) {
        stream.inputFinished();
        while (recognizer.isReady(stream)) recognizer.decode(stream);
        const text = (recognizer.getResult(stream).text || '');
        emit({ type: 'text', text, final: true });
        recognizer.reset(stream);
        lastText = '';
      }
    } else if (msg.type === 'quit') process.exit(0);
  });
  rl.on('close', () => process.exit(0));
}

try {
  main();
} catch (e) {
  emit({ type: 'error', message: String(e && e.message) });
  process.exit(1);
}
