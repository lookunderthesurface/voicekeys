// 造一批"采集数据"用于测试校准流程：把 calib/ 下的真人录音复制成一个 capture 目录 + index.jsonl，
// 其中 ourText 用**我们自己的 ASR**离线跑出来（这样报表里的对比才是真实的）。
//
//   node test/make-capture-fixture.cjs <目标目录> [每词最多几段]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));
const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { matchOne, bestScore } = require(path.join(ROOT, 'app', 'matcher.js'));

const dest = process.argv[2] || path.join(os.tmpdir(), 'vk-cap-fixture');
const perWord = Number(process.argv[3] || 5);
const MODEL_DIR = path.join(require('../app/config.js').DIRS.models, 'asr',
  'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');

const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: JSON.stringify((p.plan && p.plan.steps) || []) }));
if (!words.length) { console.error('没有绑定的词，先绑定几个再跑'); process.exit(1); }

const rec = new sherpa.OnlineRecognizer({
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
});

function ourTranscript(file) {
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

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const calib = path.join(require('../app/config.js').DIRS.root, 'calib');
let n = 0;
const lines = [];
for (const dir of fs.readdirSync(calib)) {
  const d = path.join(calib, dir);
  if (!fs.statSync(d).isDirectory()) continue;
  const wavs = fs.readdirSync(d).filter((f) => f.endsWith('.wav')).sort().slice(0, perWord);
  for (const f of wavs) {
    n += 1;
    const id = String(n).padStart(4, '0');
    const name = `seg-${id}.wav`;
    fs.copyFileSync(path.join(d, f), path.join(dest, name));
    const text = ourTranscript(path.join(d, f));
    const best = bestScore(text, words);
    const m = matchOne(text, words);
    const fired = Boolean(m && !m.ambiguous && m.score >= 0.7);
    lines.push(JSON.stringify({
      id, file: name, at: new Date().toISOString(), ms: 2500, voicedMs: 1200,
      ourText: text, bestWord: best ? best.word : '', bestScore: best ? Number(best.score.toFixed(3)) : 0,
      how: best ? best.how : '', fired, firedWord: fired ? m.word : '',
      why: fired ? 'fired' : 'borderline',
    }));
  }
}
fs.writeFileSync(path.join(dest, 'index.jsonl'), lines.join('\n') + '\n');
console.log(`  造了 ${lines.length} 段到 ${dest}`);
