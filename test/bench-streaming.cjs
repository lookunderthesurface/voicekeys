// 按当前已定算法（静音门→300ms→M1匹配→600ms门→执行；中途出声取消），
// 把每条真实录音**流式**（100ms 帧，前补 2s、后补 1s 静音）喂进 harness，统计召回/误触
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
function propose(text) {
  const em = matcher.matchAtEnd(text, words, { threshold: 0.7 });
  if (em && !em.ambiguous && em.score >= 0.7) return { word: em.word, score: em.score, how: em.how, span: 'end' };
  const all = matcher.scoreAll(text, words);
  const b = all[0];
  if (!b || b.score < 0.15) return null;
  return { word: b.word, score: b.score, how: b.how || 'loose', span: 'anywhere' };
}
function runStreaming(base) {
  const buf = new Float32Array(base.length + Math.round((LEAD / 1000) * SR) + Math.round((TAIL / 1000) * SR));
  buf.set(base, Math.round((LEAD / 1000) * SR));
  const st = m1.createStream();
  const hist = [];
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
        const fast = policy.shouldFastPath({ score: cand.score, margin: cand.margin, isHandy: false });
        if (fast) pending = { cand, kind: 'fast', fireAt: lastVoice + 6 };
        else {
          const win = buf.subarray(Math.max(0, i - Math.round((M2WIN / 1000) * SR)), i);
          const m2txt = m2t(win);
          pending = { cand, kind: 'm2', fireAt: lastVoice + 6, m2: m2txt };
        }
      }
    }
    if (pending && idx >= pending.fireAt) {
      const p = pending; pending = null;
      if (p.kind === 'fast') return { acted: p.cand.word, rule: 'fast', m1: p.cand };
      const scored = matcher.scoreAll(p.m2, words);
      const v = policy.verdictFromScores({ candidate: p.cand.word, m1Score: Number(p.cand.score) || 0, m1How: p.cand.how, scored, thresholdOf: () => 0.7 });
      const acted = (v.action === 'fire' || v.action === 'swap') ? v.word : null;
      return { acted, rule: v.rule, m1: p.cand, m2: p.m2, m2top: scored[0] };
    }
  }
  return { acted: null, rule: 'none' };
}
(async () => {
  const files = fs.readdirSync(cap).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  console.log('  真实录音 ' + files.length + ' 条，逐条流式回放（100ms 帧，前补2s/后补1s静音）+ 老师真值');
  const t = await teacher.transcribeMany(files.map((f) => path.join(cap, f)));
  if (!t.ok) { console.log('  老师失败'); return; }
  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
  let kwClips = 0, occ = 0, correct = 0, wrong = 0, miss = 0, fpClips = 0, fpTotal = 0;
  const details = [];
  for (const f of files) {
    const tt = t.results[f] || '';
    const expected = words.filter((w) => norm(tt).includes(norm(w.word))).map((w) => w.word);
    let r; try { const w = readWav(path.join(cap, f)); r = runStreaming(w.samples || w); } catch { r = { acted: null }; }
    if (expected.length) {
      kwClips += 1;
      const n = expected.reduce((a, w) => a + (norm(tt).split(norm(w)).length - 1), 0);
      occ += Math.max(n, 1);
      if (!r.acted) { miss += 1; details.push({ f, tt, expected, r, verdict: 'miss' }); }
      else if (expected.includes(r.acted)) correct += 1;
      else { wrong += 1; details.push({ f, tt, expected, r, verdict: 'wrong' }); }
    } else {
      fpTotal += 1;
      if (r.acted) { fpClips += 1; details.push({ f, tt, expected, r, verdict: 'FP' }); }
    }
  }
  console.log('');
  console.log('  === 汇总（流式回放，当前算法） ===');
  console.log('  含关键词录音: ' + kwClips + '   关键词出现次数: ' + occ);
  console.log('  正确: ' + correct + '   错词: ' + wrong + '   漏: ' + miss);
  console.log('  无关键词录音: ' + fpTotal + '   其中误触发: ' + fpClips);
  console.log('  录音级召回: ' + correct + '/' + kwClips + ' = ' + (kwClips ? (correct / kwClips * 100).toFixed(1) : '0') + '%');
  console.log('');
  console.log('  === 需要看的条目（含分数） ===');
  for (const d of details) {
    console.log('  [' + d.verdict + '] ' + d.f + ' 老师「' + d.tt + '」');
    console.log('      M1候选 ' + (d.r.m1 ? '「' + d.r.m1.word + '」' + d.r.m1.score.toFixed(2) + '(' + d.r.m1.how + '/' + d.r.m1.span + ')' : '无') +
      '   M2「' + (d.r.m2 || '') + '」' + (d.r.m2top ? ' top1=' + d.r.m2top.word + ':' + d.r.m2top.score.toFixed(2) : '') +
      '   执行 ' + (d.r.acted ? '「' + d.r.acted + '」[' + d.r.rule + ']' : '无'));
  }
})();
