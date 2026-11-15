// 计算召回率（按用户 2026-11-16 的要求）
//
//   素材里的 fast 条目当时没问 M2 → 先**补问 M2**（用同样那段音频）
//   然后所有素材都交给本地 0.6B 老师模型 → 得到"这段话到底说了什么"（真值）
//   最后算三个召回率：
//     整体召回 = 我们实际执行的词 == 真值词
//     M2 召回  = M2 判出来的词 == 真值词
//     M1 召回  = M1 提出的词 == 真值词
//
// 用法：node scripts/recall.cjs
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));
const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { matchAtEnd, bestScore } = require(path.join(ROOT, 'app', 'matcher.js'));
const teacher = require(path.join(ROOT, 'app', 'teacher.js'));

const BASE = require('../app/config.js').DIRS.root;
const CAP = path.join(BASE, 'capture');
const M2_DIR = path.join(BASE, 'models', 'asr', 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: 'p' }));
const THRESHOLD = 0.7;

function loadRows() {
  const f = path.join(CAP, 'index.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function m2Text(file) {
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: { model: path.join(M2_DIR, 'model.int8.onnx') },
      tokens: path.join(M2_DIR, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0,
    },
  });
  const st = rec.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples: readWav(file) });
  rec.decode(st);
  return (rec.getResult(st).text || '').trim();
}

function wordOf(text) {
  if (!text) return null;
  const m = matchAtEnd(text, words, { threshold: THRESHOLD });
  return m && !m.ambiguous ? m.word : null;
}

(async () => {
  const rows = loadRows();
  if (!rows.length) { console.log('  素材为空，先录一些再来算'); return; }
  console.log('  素材 ' + rows.length + ' 条：' + JSON.stringify(
    rows.reduce((a, r) => { a[r.why] = (a[r.why] || 0) + 1; return a; }, {}),
  ));

  // 1) fast 条目补问 M2
  let repaired = 0;
  for (const r of rows) {
    if (r.why !== 'fast') continue;
    try {
      r.m2Text = m2Text(path.join(CAP, r.file));
      repaired += 1;
    } catch { r.m2Text = ''; }
  }
  console.log('  fast 条目补问 M2: ' + repaired + ' 条');

  // 2) 老师模型给真值
  const files = rows.map((r) => path.join(CAP, r.file)).filter((f) => fs.existsSync(f));
  console.log('  老师模型转写中（' + files.length + ' 条）…');
  const t0 = Date.now();
  const t = await teacher.transcribeMany(files, (done, total) => {
    if (done % 10 === 0 || done === total) process.stdout.write('    ' + done + '/' + total + '\n');
  });
  if (!t.ok) { console.log('  老师模型失败: ' + t.error); return; }
  console.log('  老师完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's（加载 ' + t.loadMs + 'ms）');

  const truthByFile = new Map();
  for (const [name, text] of Object.entries(t.results || {})) truthByFile.set(path.basename(name), String(text || '').trim());

  // 3) 逐条对照
  let n = 0;
  let m1Hit = 0;
  let m2Hit = 0;
  let allHit = 0;
  let fp = 0;
  let fpTotal = 0;
  const detail = [];

  for (const r of rows) {
    const truthText = truthByFile.get(r.file) || '';
    const truth = wordOf(truthText);
    const m1 = wordOf(r.ourText);
    const m2 = wordOf(r.m2Text || '');
    const executed = r.fired ? (r.why === 'fast' ? m1 : m2) : null;

    if (truth) {
      n += 1;
      if (m1 === truth) m1Hit += 1;
      if (m2 === truth) m2Hit += 1;
      if (executed === truth) allHit += 1;
    } else {
      fpTotal += 1;
      if (executed) fp += 1;
    }
    detail.push({ id: r.id, why: r.why, truth, m1, m2, executed, truthText, m1Text: r.ourText, m2Text: r.m2Text });
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  console.log('');
  console.log('  真值里有命令的素材: ' + n + ' 条；真值里不是命令的: ' + fpTotal + ' 条');
  console.log('  ┌──────────────────────────────────────┐');
  console.log('  │ 整体召回（实际执行的词 == 真值）: ' + allHit + '/' + n + ' = ' + pct(allHit, n) + '%');
  console.log('  │ M2 召回                          : ' + m2Hit + '/' + n + ' = ' + pct(m2Hit, n) + '%');
  console.log('  │ M1 召回                          : ' + m1Hit + '/' + n + ' = ' + pct(m1Hit, n) + '%');
  console.log('  │ 误触发（真值不是命令却执行了）  : ' + fp + '/' + fpTotal + ' = ' + pct(fp, fpTotal) + '%');
  console.log('  └──────────────────────────────────────┘');

  const wrong = detail.filter((d) => d.truth && d.executed && d.executed !== d.truth);
  if (wrong.length) {
    console.log('  执行错词的条目:');
    for (const d of wrong) console.log('    ' + d.id + ' 真值『' + d.truthText + '』→ 我们执行了「' + d.executed + '」');
  }
  const missed = detail.filter((d) => d.truth && !d.executed);
  if (missed.length) {
    console.log('  漏掉的条目:');
    for (const d of missed.slice(0, 10)) {
      console.log('    ' + d.id + ' 真值『' + d.truthText + '』 M1「' + (d.m1Text || '空') + '」 M2「' + (d.m2Text || '') + '」');
    }
  }
})();
