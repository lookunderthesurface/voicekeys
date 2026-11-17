// 分母 = 1.7B 老师识别出的关键词个数（次数级），句尾窗口候选；流式喂录音
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const paths = require(path.join(ROOT, 'app', 'paths.js'));
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const policy = require(path.join(ROOT, 'app', 'pipeline', 'policy.js'));
const teacher = require(path.join(ROOT, 'app', 'teacher.js'));
const { readWav } = require(path.join(paths.pluginRoot(), 'runtime', 'listener', 'audio.cjs'));
const sherpa = require(path.join(paths.packageDir('sherpa-onnx-node') || '', 'node_modules', 'sherpa-onnx-node'));
const ASR = path.join(config.DIRS.models, 'asr');
const M1D = path.join(ASR, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const M2D = path.join(ASR, 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const SR = 16000, FRAME = 1600, LEAD = 2000, TAIL = 1000, VMIN = 3, VWIN = 50, M2WIN = 4000;
const cap = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'VoiceKeys', 'capture');
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: p.say }));
const m1 = new sherpa.OnlineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { transducer: { encoder: path.join(M1D, 'encoder-epoch-99-avg-1.int8.onnx'), decoder: path.join(M1D, 'decoder-epoch-99-avg-1.int8.onnx'), joiner: path.join(M1D, 'joiner-epoch-99-avg-1.int8.onnx') }, tokens: path.join(M1D, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 }, decodingMethod: 'greedy_search' });
const m2 = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { paraformer: { model: path.join(M2D, 'model.int8.onnx') }, tokens: path.join(M2D, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0 } });
function m2t(p) { const st = m2.createStream(); st.acceptWaveform({ sampleRate: SR, samples: p }); m2.decode(st); return (m2.getResult(st).text || '').trim(); }
function tailScore(t, w) {
  const Lw = w.length; let best = { score: 0, how: 'none' };
  for (let k = Lw; k <= Math.min(t.length, Lw + 2); k += 1) {
    const r = matcher.scoreAgainst(t.slice(t.length - k), w);
    if (r && r.score > best.score) best = r;
  }
  return best;
}
function propose(t) {
  const em = matcher.matchAtEnd(t, words, { threshold: 0.7 });
  if (em && !em.ambiguous && em.score >= 0.7) return { word: em.word, score: em.score, how: em.how, span: 'end' };
  const all = words.map((w) => ({ word: w.word, ...tailScore(t, w.word) })).sort((a, b) => b.score - a.score);
  const b = all[0];
  if (!b || b.score < 0.15) return null;
  return { word: b.word, score: b.score, how: b.how, span: 'tail' };
}
function run(base) {
  const buf = new Float32Array(base.length + Math.round((LEAD / 1000) * SR) + Math.round((TAIL / 1000) * SR));
  buf.set(base, Math.round((LEAD / 1000) * SR));
  const st = m1.createStream(); const hist = [];
  let lastVoice = 0, matched = false, pending = null, idx = 0;
  for (let i = 0; i + FRAME <= buf.length; i += FRAME) {
    idx += 1;
    st.acceptWaveform({ sampleRate: SR, samples: buf.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
    const text = (m1.getResult(st).text || '').trim();
    let s = 0; for (let j = 0; j < FRAME; j += 1) s += buf[i + j] * buf[i + j];
    const voice = Math.sqrt(s / FRAME) > 0.02;
    hist.push(voice ? 1 : 0); if (hist.length > VWIN) hist.shift();
    if (voice) { lastVoice = idx; matched = false; pending = null; continue; }
    if (!lastVoice) continue;
    const silentRun = idx - lastVoice;
    const voiced = hist.reduce((a, b) => a + b, 0);
    if (!matched && silentRun >= VMIN && voiced >= VMIN) {
      matched = true;
      const cand = propose(text);
      if (cand) {
        if (policy.shouldFastPath({ score: cand.score, margin: cand.margin, isHandy: false })) pending = { cand, kind: 'fast', fireAt: lastVoice + 6 };
        else {
          const win = buf.subarray(Math.max(0, i - Math.round((M2WIN / 1000) * SR)), i);
          pending = { cand, kind: 'm2', fireAt: lastVoice + 6, m2: m2t(win) };
        }
      }
    }
    if (pending && idx >= pending.fireAt) {
      const p = pending; pending = null;
      if (p.kind === 'fast') return { acted: p.cand.word, rule: 'fast', m1: p.cand };
      const m2s = String(p.m2 || '');
      const tsc = (w) => {
        const Lw = String(w).length; let sc = 0;
        for (let k = Lw; k <= Math.min(m2s.length, Lw + 2); k += 1) {
          const r = matcher.scoreAgainst(m2s.slice(m2s.length - k), w);
          if (r && r.score > sc) sc = r.score;
        }
        return sc;
      };
      const scored = words.map((w) => ({ word: w.word, score: tsc(w.word) })).sort((a, b) => b.score - a.score);
      const v = policy.verdictFromScores({ candidate: p.cand.word, m1Score: Number(p.cand.score) || 0, m1How: p.cand.how, scored, thresholdOf: () => 0.7 });
      const acted = (v.action === 'fire' || v.action === 'swap') ? v.word : null;
      return { acted, rule: v.rule, m1: p.cand, m2: p.m2, m2top: scored[0] };
    }
  }
  return { acted: null, rule: 'none' };
}
(async () => {
  const files = fs.readdirSync(cap).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  const t = await teacher.transcribeMany(files.map((f) => path.join(cap, f)));
  if (!t.ok) { console.log('  老师失败'); return; }
  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
  let occ = 0, correct = 0, wrong = 0, miss = 0, fpClips = 0, noKw = 0;
  const rows = [];
  for (const f of files) {
    const tt = t.results[f] || '';
    const counts = words.map((w) => ({ w: w.word, n: norm(tt).split(norm(w.word)).length - 1 })).filter((x) => x.n > 0);
    let r; try { const w = readWav(path.join(cap, f)); r = run(w.samples || w); } catch { r = { acted: null }; }
    if (!counts.length) { noKw += 1; if (r.acted) fpClips += 1; continue; }
    for (const c of counts) {
      occ += c.n;
      if (r.acted === c.w) correct += Math.min(1, c.n);
      else if (!r.acted) miss += c.n;
      else if (counts.some((x) => x.w === r.acted)) miss += c.n - 1 > 0 ? c.n - 1 : 0;
      else { wrong += 1; miss += c.n; }
    }
    rows.push({ f, tt, counts, r });
  }
  console.log('');
  console.log('  === 分母 = 1.7B 老师数出的关键词次数 ===');
  console.log('  关键词总次数: ' + occ + '   正确: ' + correct + '   错词: ' + wrong + '   漏: ' + (occ - correct - wrong));
  console.log('  次数级召回: ' + correct + '/' + occ + ' = ' + (occ ? (correct / occ * 100).toFixed(1) : '0') + '%');
  console.log('  无关键词录音: ' + noKw + '   误触发: ' + fpClips);
})();
