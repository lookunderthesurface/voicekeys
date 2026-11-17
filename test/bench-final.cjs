// 新拼音打分的次数级复测：分母=1.7B关键词次数；允许多次执行（无同句去重）；误触发按无关键词录音计
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
const cap = path.join(process.env.LOCALAPPDATA || '', 'VoiceKeys', 'capture');
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: p.say }));
const m1 = new sherpa.OnlineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { transducer: { encoder: path.join(M1D, 'encoder-epoch-99-avg-1.int8.onnx'), decoder: path.join(M1D, 'decoder-epoch-99-avg-1.int8.onnx'), joiner: path.join(M1D, 'joiner-epoch-99-avg-1.int8.onnx') }, tokens: path.join(M1D, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 }, decodingMethod: 'greedy_search' });
const m2 = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { paraformer: { model: path.join(M2D, 'model.int8.onnx') }, tokens: path.join(M2D, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0 } });
function m2t(p) { const st = m2.createStream(); st.acceptWaveform({ sampleRate: SR, samples: p }); m2.decode(st); return (m2.getResult(st).text || '').trim(); }
function tailScore(t, w) {
  const Lw = String(w).length; let sc = 0; let how = 'none';
  for (let k = Math.min(Lw, t.length); k <= Math.min(t.length, Lw + 2); k += 1) {
    const r = matcher.scoreAgainst(t.slice(t.length - k), w);
    if (r && r.score > sc) { sc = r.score; how = r.how; }
  }
  return { score: sc, how };
}
function propose(t) {
  if (!t) return null;
  const em = matcher.matchAtEnd(t, words, { threshold: 0.7 });
  if (em && !em.ambiguous && em.score >= 0.7) return { word: em.word, score: em.score, how: em.how, span: 'end' };
  const all = words.map((w) => ({ word: w.word, ...tailScore(t, w.word) })).sort((a, b) => b.score - a.score);
  const b = all[0];
  if (!b || b.score < 0.15) return null;
  return { word: b.word, score: b.score, how: b.how, span: 'tail' };
}
function runClip(base) {
  const buf = new Float32Array(base.length + Math.round((LEAD / 1000) * SR) + Math.round((TAIL / 1000) * SR));
  buf.set(base, Math.round((LEAD / 1000) * SR));
  const st = m1.createStream(); const hist = [];
  let lastVoice = 0, matched = false, pending = null, idx = 0;
  const actions = [];
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
          const m2s = m2t(win);
          const scored = words.map((w) => ({ word: w.word, ...tailScore(m2s, w.word) })).sort((a, b) => b.score - a.score);
          const v = policy.verdictFromScores({ candidate: cand.word, m1Score: Number(cand.score) || 0, m1How: cand.how, scored, thresholdOf: () => 0.7 });
          pending = { cand, kind: 'm2', fireAt: lastVoice + 6, v };
        }
      }
    }
    if (pending && idx >= pending.fireAt) {
      const p = pending; pending = null;
      if (p.kind === 'fast') actions.push(p.cand.word);
      else if (p.v.action === 'fire' || p.v.action === 'swap') actions.push(p.v.word);
    }
  }
  return actions;
}
(async () => {
  const files = fs.readdirSync(cap).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  const t = await teacher.transcribeMany(files.map((f) => path.join(cap, f)));
  if (!t.ok) { console.log('teacher fail'); return; }
  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
  let occ = 0, got = 0, fp = 0, noKw = 0;
  const missRows = [];
  for (const f of files) {
    const tt = t.results[f] || '';
    const counts = words.map((w) => ({ w: w.word, n: norm(tt).split(norm(w.word)).length - 1 })).filter((x) => x.n > 0);
    let acts = []; try { const w = readWav(path.join(cap, f)); acts = runClip(w.samples || w); } catch { acts = []; }
    if (!counts.length) { noKw += 1; if (acts.length) fp += 1; continue; }
    for (const c of counts) {
      occ += c.n;
      got += Math.min(c.n, acts.filter((a) => a === c.w).length);
    }
    const missing = counts.reduce((a, c) => a + c.n, 0) - counts.reduce((a, c) => a + Math.min(c.n, acts.filter((x) => x === c.w).length), 0);
    if (missing > 0) missRows.push({ f, tt, actions: acts, missing: missing });
  }
  console.log('');
  console.log('  === 新拼音打分（部分相似 + 长度折扣）次数级复测 ===');
  console.log('  关键词总次数 ' + occ + '  命中 ' + got + '  漏 ' + (occ - got) + '  召回 ' + (occ ? (got / occ * 100).toFixed(1) : 0) + '%');
  console.log('  无关键词录音 ' + noKw + '  误触发 ' + fp);
  console.log('  仍漏的录音: ' + missRows.map((r) => r.f + '(漏' + r.missing + ')').join(' '));
})();
