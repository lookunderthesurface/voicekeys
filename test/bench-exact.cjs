// 验证用户精确规则：最近三帧静音+过去5s有声≥3帧 → 跑一次匹配；600ms 门从最后一个有声帧起算
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
const M1_DIR = path.join(ASR, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const M2_DIR = path.join(ASR, 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const SR = 16000; const FRAME = 1600; const LEAD = 2000; const VMIN = 3; const VWIN = 50; const M2WIN = 4000;
const cap = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'VoiceKeys', 'capture');
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: p.say }));
const planOf = new Map(planner.listVerbose().map((p) => [p.say, JSON.stringify((p.plan && p.plan.steps) || [])]));
const samePlan = (a, b) => a && b && planOf.get(a) === planOf.get(b);
const m1 = new sherpa.OnlineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { transducer: { encoder: path.join(M1_DIR, 'encoder-epoch-99-avg-1.int8.onnx'), decoder: path.join(M1_DIR, 'decoder-epoch-99-avg-1.int8.onnx'), joiner: path.join(M1_DIR, 'joiner-epoch-99-avg-1.int8.onnx') }, tokens: path.join(M1_DIR, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 }, decodingMethod: 'greedy_search' });
const m2 = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { paraformer: { model: path.join(M2_DIR, 'model.int8.onnx') }, tokens: path.join(M2_DIR, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0 } });
function m2t(pcm) { const st = m2.createStream(); st.acceptWaveform({ sampleRate: SR, samples: pcm }); m2.decode(st); return (m2.getResult(st).text || '').trim(); }
function propose(text) {
  if (!text) return null;
  const em = matcher.matchAtEnd(text, words, { threshold: 0.7 });
  if (em && !em.ambiguous && em.score >= 0.7) return { word: em.word, score: em.score, how: em.how, margin: null };
  const best = matcher.bestScore(text, words);
  if (!best || best.score < policy.DEFAULT_POLICY.candidateFloor) return null;
  const all = matcher.scoreAll(text, words);
  return { word: best.word, score: best.score, how: best.how || 'loose', margin: Math.max(0, best.score - (all[1] ? all[1].score : 0)) };
}
function run(base) {
  const tail = SR; const buf = new Float32Array(base.length + Math.round((LEAD / 1000) * SR) + tail); buf.set(base, Math.round((LEAD / 1000) * SR));
  const st = m1.createStream(); const hist = [];
  let lastVoiceIdx = 0; let matched = false; let pending = null; let idx = 0;
  for (let i = 0; i + FRAME <= buf.length; i += FRAME) {
    idx += 1;
    st.acceptWaveform({ sampleRate: SR, samples: buf.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
    const text = (m1.getResult(st).text || '').trim();
    let s = 0; for (let j = 0; j < FRAME; j += 1) s += buf[i + j] * buf[i + j];
    const voice = Math.sqrt(s / FRAME) > 0.02;
    hist.push(voice ? 1 : 0); if (hist.length > VWIN) hist.shift();
    if (voice) { lastVoiceIdx = idx; matched = false; pending = null; continue; }
    if (!lastVoiceIdx) continue;
    const silentRun = idx - lastVoiceIdx; const voiced = hist.reduce((a, b) => a + b, 0);
    if (!matched && silentRun >= VMIN && voiced >= VMIN) {
      matched = true;
      const cand = propose(text);
      if (cand) {
        const fast = policy.shouldFastPath({ score: cand.score, margin: cand.margin, isHandy: false });
        if (fast) pending = { cand, kind: 'fast', fireAt: lastVoiceIdx + 6 };
        else {
          const m2txt = m2t(buf.subarray(Math.max(0, i - Math.round((M2WIN / 1000) * SR)), i));
          pending = { cand, kind: 'm2', fireAt: lastVoiceIdx + 6, m2: m2txt };
        }
      }
    }
    if (pending && idx >= pending.fireAt) {
      const p = pending; pending = null;
      if (p.kind === 'fast') return { acted: p.cand.word, rule: 'fast', m1: p.cand };
      const v = policy.verdictFromScores({ candidate: p.cand.word, m1Score: Number(p.cand.score) || 0, m1How: p.cand.how, scored: matcher.scoreAll(p.m2, words), thresholdOf: () => 0.7 });
      const acted = (v.action === 'fire' || v.action === 'swap') ? v.word : null;
      return { acted, rule: v.rule, m1: p.cand, m2: p.m2 };
    }
  }
  return { acted: null, rule: 'none' };
}
(async () => {
  const files = fs.readdirSync(cap).filter((f) => f.endsWith('.wav')).sort();
  console.log('  素材 ' + files.length + ' 条；老师转写中…');
  const t = await teacher.transcribeMany(files.map((f) => path.join(cap, f)));
  if (!t.ok) { console.log('  老师失败'); return; }
  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
  const rows = [];
  for (const f of files) {
    const tt = t.results[f] || '';
    const expected = words.filter((w) => norm(tt).includes(norm(w.word))).map((w) => w.word);
    let r; try { const w = readWav(path.join(cap, f)); r = run(w.samples || w); } catch { r = { acted: null }; }
    rows.push({ f, tt, expected, r });
  }
  const focus = rows.filter((x) => x.expected.includes('暂停视频'));
  console.log('\n=== 含「暂停视频」' + focus.length + ' 条 ===');
  for (const x of focus) console.log('  ' + x.f + ' 「' + x.tt + '」 → ' + (x.r.acted ? '执行「' + x.r.acted + '」[' + x.r.rule + '] M1=' + x.r.m1.score.toFixed(2) : '未执行'));
  const execPause = focus.filter((x) => x.r.acted === '暂停视频' || samePlan(x.r.acted, '暂停视频'));
  const actedOther = focus.filter((x) => x.r.acted && !(x.r.acted === '暂停视频' || samePlan(x.r.acted, '暂停视频')));
  const notActed = focus.filter((x) => !x.r.acted);
  console.log('  执行了「暂停视频」: ' + execPause.length + '/' + focus.length);
  console.log('  执行了别的关键词: ' + actedOther.length + (actedOther.length ? '（' + actedOther.map((x) => x.f + '→' + x.r.acted).join(', ') + '）' : ''));
  console.log('  没执行: ' + notActed.length + (notActed.length ? '（' + notActed.map((x) => x.f).join(', ') + '）' : ''));
  const noKw = rows.filter((x) => x.expected.length === 0);
  const fps = noKw.filter((x) => x.r.acted);
  console.log('\n=== 老师无关键词 ' + noKw.length + ' 条 → 误触发 ' + fps.length + ' 条' + (fps.length ? '：' + fps.map((x) => x.f + '→' + x.r.acted).join(', ') : ''));
})();
