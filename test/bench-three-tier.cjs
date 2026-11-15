// 三段式策略的离线验证：在同一批 26 段可用录音上跑完整策略
//
//   ① 有声 < 0.5s            → 丢弃
//   ② M1 ≥0.95 + 命令词 + 有声≥0.5s → 直接执行（不叫 M2）
//   ③ 其它有语音              → 问 M2；M1 没词时由 M2 直接判
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));
const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { matchAtEnd, bestScore } = require(path.join(ROOT, 'app', 'matcher.js'));
const { decide, shouldPropose, shouldFastPath } = require(path.join(ROOT, 'app', 'pipeline', 'policy.js'));

const BASE = require('../app/config.js').DIRS.root;
const M1_DIR = path.join(BASE, 'models', 'asr', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const M2_DIR = path.join(BASE, 'models', 'asr', 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const CALIB = path.join(BASE, 'calib');
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: 'p' }));
const list = planner.listVerbose().map((p) => p.say);
const T = 0.7;
const handy = new Set(planner.listVerbose()
  .filter((p) => p.plan && Array.isArray(p.plan.steps) && p.plan.steps.some((s) => s.op === 'handy.set'))
  .map((p) => p.say));

const m1 = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(M1_DIR, 'encoder-epoch-99-avg-1.int8.onnx'),
      decoder: path.join(M1_DIR, 'decoder-epoch-99-avg-1.int8.onnx'),
      joiner: path.join(M1_DIR, 'joiner-epoch-99-avg-1.int8.onnx'),
    },
    tokens: path.join(M1_DIR, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0,
  },
  decodingMethod: 'greedy_search',
});
const m2 = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    paraformer: { model: path.join(M2_DIR, 'model.int8.onnx') },
    tokens: path.join(M2_DIR, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0,
  },
});

function voicedMs(pcm) {
  let v = 0;
  for (let i = 0; i + 1600 <= pcm.length; i += 1600) {
    let ps = 0;
    for (let j = 0; j < 1600; j += 1) ps += pcm[i + j] * pcm[i + j];
    if (Math.sqrt(ps / 1600) > 0.03) v += 1;
  }
  return v * 100;
}
function m1Text(pcm) {
  const st = m1.createStream();
  for (let i = 0; i + 1600 <= pcm.length; i += 1600) {
    st.acceptWaveform({ sampleRate: 16000, samples: pcm.subarray(i, i + 1600) });
    while (m1.isReady(st)) m1.decode(st);
  }
  st.inputFinished();
  while (m1.isReady(st)) m1.decode(st);
  return (m1.getResult(st).text || '').trim();
}
function m2Text(pcm) {
  const st = m2.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples: pcm });
  m2.decode(st);
  return (m2.getResult(st).text || '').trim();
}

const rows = [];
for (const dir of fs.readdirSync(CALIB)) {
  const d = path.join(CALIB, dir);
  if (!fs.statSync(d).isDirectory() || !list.includes(dir)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.wav')).sort()) {
    const pcm = readWav(path.join(d, f));
    rows.push({ expect: dir, pcm, voiced: voicedMs(pcm) });
  }
}

let fired = 0;
let correct = 0;
let wrongWord = 0;
let m2calls = 0;
let fastpath = 0;
let audioOnly = 0;
const detail = [];

for (const r of rows) {
  if (r.voiced < 500) { detail.push([r.expect, '丢弃(静音)', '', '']); continue; }   // ①

  const t1 = m1Text(r.pcm);
  const end = matchAtEnd(t1, words, { threshold: T });
  const best = bestScore(t1, words);
  let cand = null;
  if (end && !end.ambiguous && end.score >= T) {
    cand = { word: end.word, score: end.score, how: end.how };
  } else {
    const p = shouldPropose(best, { threshold: T });
    cand = p.propose ? { word: best.word, score: best.score, how: best.how } : null;
  }

  if (!cand) { detail.push([r.expect, '丢弃(M1 判否)', '', t1]); continue; }

  // ② 快速通道
  const isHandy = handy.has(cand.word);
  if (cand.word && shouldFastPath({ score: cand.score, isHandy, voicedMs: r.voiced })) {
    fastpath += 1;
    fired += 1;
    if (cand.word === r.expect) correct += 1; else wrongWord += 1;
    detail.push([r.expect, '快速通道', cand.word, t1]);
    continue;
  }

  // ③ 问 M2
  m2calls += 1;
  const t2 = m2Text(r.pcm);
  const m2m = t2 ? matchAtEnd(t2, words, { threshold: T }) : null;
  const m2Word = m2m && !m2m.ambiguous ? m2m.word : null;

  if (!cand) { detail.push([r.expect, '丢弃(M1 判否)', '', t1]); continue; }

  const v = decide({
    word: cand.word, m1Score: cand.score, m1How: cand.how,
    m2Word, m2Text: t2, m2Usable: true, isHandy, threshold: T,
  });
  if (v.action === 'fire' || v.action === 'swap') {
    fired += 1;
    const w = v.word || cand.word;
    if (w === r.expect) correct += 1; else wrongWord += 1;
    detail.push([r.expect, v.rule, w, t1 + ' / ' + t2]);
  } else {
    detail.push([r.expect, '丢弃:' + v.rule, '', t1 + ' / ' + t2]);
  }
}

const usable = rows.filter((r) => r.voiced >= 500).length;
console.log('  总 ' + rows.length + ' 段，可用 ' + usable + ' 段（静音 ' + (rows.length - usable) + ' 段被挡掉）');
console.log('  触发 ' + fired + ' 次：正确 ' + correct + '，错词 ' + wrongWord);
console.log('  召回（可用口径）: ' + Math.round(correct / usable * 100) + '%');
console.log('  M2 调用: ' + m2calls + '/' + usable + '（快速通道跳过 ' + fastpath + '，M2 独判 ' + audioOnly + '）');
console.log('');
console.log('  逐段:');
for (const [expect, how, word, texts] of detail) {
  console.log('    ' + expect.padEnd(8) + how.padEnd(16) + (word ? '→ ' + word : '') + '   ' + (texts || ''));
}
