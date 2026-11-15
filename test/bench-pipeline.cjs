// 触发链路基准：拿 calib/ 下每个词的真人录音，跑"我们的 ASR + 匹配"，看每个词到底能中多少。
//
//   node test/bench-pipeline.cjs            # 基准（当前模型、无热词）
//   node test/bench-pipeline.cjs --hotwords # 加热词偏置再跑一遍
//
// 输出：每个词 x/y 命中、失败时模型听成了什么。这就是"瓶颈在哪里"的证据。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));
const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { matchOne } = require(path.join(ROOT, 'app', 'matcher.js'));

const MODEL_DIR = path.join(require('../app/config.js').DIRS.models, 'asr',
  'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const CALIB = path.join(require('../app/config.js').DIRS.root, 'calib');
const THRESHOLD = 0.70;

const useHotwords = process.argv.includes('--hotwords');
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: JSON.stringify((p.plan && p.plan.steps) || []) }));

function buildRecognizer() {
  const cfg = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(MODEL_DIR, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(MODEL_DIR, 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner: path.join(MODEL_DIR, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(MODEL_DIR, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  };
  if (useHotwords) {
    const file = path.join(process.env.TEMP || '.', 'vk-hotwords.txt');
    fs.writeFileSync(file, words.map((w) => w.word).join('\n') + '\n');
    cfg.modelConfig.modelingUnit = 'cjkchar';
    cfg.modelConfig.hotwordsFile = file;
    cfg.modelConfig.hotwordsScore = 2.0;
  }
  return new sherpa.OnlineRecognizer(cfg);
}

function transcribe(rec, file) {
  const s = readWav(file);
  const st = rec.createStream();
  for (let i = 0; i + 1600 <= s.length; i += 1600) {
    st.acceptWaveform({ sampleRate: 16000, samples: s.subarray(i, i + 1600) });
    while (rec.isReady(st)) rec.decode(st);
  }
  st.inputFinished();
  while (rec.isReady(st)) rec.decode(st);
  return (rec.getResult(st).text || '').trim();
}

console.log(`\n模式: ${useHotwords ? '热词偏置' : '基准'}（阈值 ${THRESHOLD}）`);
let rec;
try {
  rec = buildRecognizer();
} catch (e) {
  console.log('  识别器创建失败: ' + e.message);
  process.exit(1);
}

let total = 0;
let hit = 0;
const rows = [];
for (const dir of fs.readdirSync(CALIB)) {
  const d = path.join(CALIB, dir);
  if (!fs.statSync(d).isDirectory()) continue;
  if (!words.some((w) => w.word === dir)) continue;   // 已经解绑的词不算（例如 over）
  const wavs = fs.readdirSync(d).filter((f) => f.endsWith('.wav')).sort();
  if (!wavs.length) continue;
  let k = 0;
  const misses = [];
  for (const f of wavs) {
    const text = transcribe(rec, path.join(d, f));
    const m = matchOne(text, words, { threshold: THRESHOLD });
    const ok = Boolean(m && !m.ambiguous && m.word === dir);
    total += 1;
    if (ok) { hit += 1; k += 1; } else { misses.push({ text, m: m && (m.ambiguous ? '歧义:' + m.ambiguous.join('/') : m.word + '@' + m.score) }); }
  }
  rows.push({ word: dir, ok: k, n: wavs.length, misses });
}

rows.sort((a, b) => (a.ok / a.n) - (b.ok / b.n));
for (const r of rows) {
  console.log(`  ${r.word.padEnd(8)} ${r.ok}/${r.n}` + (r.misses.length ? '   失败时听到: ' + r.misses.map((x) => `「${x.text}」`).join(' ') : ''));
}
console.log(`\n  合计 ${hit}/${total} = ${(hit / total * 100).toFixed(0)}%`);
