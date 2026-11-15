// 候选"确认模型"评测：paraformer-zh-small（78MB，非流式，CPU）
//
// 用户关心的三件事：
//   ① 加载要多久（能不能塞进静音门 600~1000ms）
//   ② 单句推理多久
//   ③ 准确率比现在的 14M 流式模型好多少（拿真人录音比）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));
const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { matchOne } = require(path.join(ROOT, 'app', 'matcher.js'));

const DIR = process.argv[2];
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: JSON.stringify((p.plan && p.plan.steps) || []) }));
const CALIB = path.join(require('../app/config.js').DIRS.root, 'calib');

function buildRecognizer() {
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: { model: path.join(DIR, 'model.int8.onnx') },
      tokens: path.join(DIR, 'tokens.txt'),
      numThreads: 1,          // CPU 单线程（和流式模型同样的理由：多线程会自旋）
      provider: 'cpu',
      debug: 0,
    },
  });
}

// ① 加载耗时（三次取中位数，排除首次磁盘缓存影响）
const loads = [];
for (let i = 0; i < 3; i += 1) {
  const t0 = Date.now();
  const rec = buildRecognizer();
  loads.push(Date.now() - t0);
  if (i < 2) rec.free ? rec.free() : null;
  if (i === 2) var last = rec;
}
loads.sort((a, b) => a - b);
console.log('  加载耗时（CPU，单线程）: ' + loads.join(' / ') + ' ms，中位数 ' + loads[1] + ' ms');
console.log('  常驻 RSS: ' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');

const rec = last;

// ② 推理耗时 + ③ 准确率
let total = 0;
let hit = 0;
const rows = [];
for (const dir of fs.readdirSync(CALIB)) {
  const d = path.join(CALIB, dir);
  if (!fs.statSync(d).isDirectory()) continue;
  if (!words.some((w) => w.word === dir)) continue;
  const wavs = fs.readdirSync(d).filter((f) => f.endsWith('.wav')).sort();
  if (!wavs.length) continue;
  let k = 0;
  const misses = [];
  let inferMs = 0;
  for (const f of wavs) {
    const pcm = readWav(path.join(d, f));
    const t0 = Date.now();
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: 16000, samples: pcm });
    rec.decode(st);
    const text = (rec.getResult(st).text || '').trim();
    inferMs += Date.now() - t0;
    const m = matchOne(text, words, { threshold: 0.7 });
    const ok = Boolean(m && !m.ambiguous && m.word === dir);
    total += 1;
    if (ok) { hit += 1; k += 1; } else misses.push(text);
  }
  rows.push({ word: dir, ok: k, n: wavs.length, avgMs: Math.round(inferMs / wavs.length), misses });
}

rows.sort((a, b) => (a.ok / a.n) - (b.ok / b.n));
for (const r of rows) {
  console.log('  ' + r.word.padEnd(8) + ' ' + r.ok + '/' + r.n + '  ' + r.avgMs + 'ms/句' + (r.misses.length ? '   失败: ' + r.misses.map((x) => '「' + x + '」').join(' ') : ''));
}
console.log('  合计 ' + hit + '/' + total + ' = ' + Math.round((hit / total) * 100) + '%');
