// 新算法离线验证：只在"过去5秒有声>300ms 且当前帧静音"时匹配 → 三选一（自信/拒绝/问M2）
// 对照：老师（1.7B）作为答案
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
const SR = 16000;
const FRAME = 1600;
const LEAD_MS = 2000;
const VOICED_WIN = 50;
const VOICED_MIN = 3;
const M2_WIN_MS = 4000;
const cap = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'VoiceKeys', 'capture');

const verbose = planner.listVerbose();
const words = verbose.map((p) => ({ word: p.say, planKey: p.say }));
const planOf = new Map(verbose.map((p) => [p.say, JSON.stringify((p.plan && p.plan.steps) || [])]));
const samePlan = (a, b) => a && b && planOf.get(a) === planOf.get(b);

const m1 = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: SR, featureDim: 80 },
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
  featConfig: { sampleRate: SR, featureDim: 80 },
  modelConfig: {
    paraformer: { model: path.join(M2_DIR, 'model.int8.onnx') },
    tokens: path.join(M2_DIR, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0,
  },
});
function m2Text(pcm) {
  const st = m2.createStream();
  st.acceptWaveform({ sampleRate: SR, samples: pcm });
  m2.decode(st);
  return (m2.getResult(st).text || '').trim();
}
function propose(text) {
  if (!text) return null;
  const endMatch = matcher.matchAtEnd(text, words, { threshold: 0.7 });
  if (endMatch && !endMatch.ambiguous && endMatch.score >= 0.7) return { word: endMatch.word, score: endMatch.score, how: endMatch.how, margin: null };
  const best = matcher.bestScore(text, words);
  if (!best || best.score < policy.DEFAULT_POLICY.candidateFloor) return null;
  const all = matcher.scoreAll(text, words);
  return { word: best.word, score: best.score, how: best.how || 'loose', margin: Math.max(0, best.score - (all[1] ? all[1].score : 0)) };
}

function runSilence(base) {
  const buf = new Float32Array(base.length + Math.round((LEAD_MS / 1000) * SR));
  buf.set(base, Math.round((LEAD_MS / 1000) * SR));
  const st = m1.createStream();
  const hist = [];
  let decided = false;
  const fired = new Set();
  for (let i = 0; i + FRAME <= buf.length; i += FRAME) {
    st.acceptWaveform({ sampleRate: SR, samples: buf.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
    const text = (m1.getResult(st).text || '').trim();
    let s = 0;
    for (let j = 0; j < FRAME; j += 1) s += buf[i + j] * buf[i + j];
    const rms = Math.sqrt(s / FRAME);
    const voice = rms > 0.02;
    hist.push(voice ? 1 : 0);
    if (hist.length > VOICED_WIN) hist.shift();
    if (voice) { decided = false; continue; }
    if (decided) continue;
    if (hist.reduce((a, b) => a + b, 0) < VOICED_MIN) continue;
    const cand = propose(text);
    if (!cand) continue;
    if (fired.has(cand.word)) { decided = true; continue; }
    if (policy.shouldFastPath({ score: cand.score, margin: cand.margin, isHandy: false })) {
      fired.add(cand.word);
      decided = true;
      return { fired: true, acted: cand.word, rule: 'silence-fast', m1: cand };
    }
    const m2txt = m2Text(buf.subarray(Math.max(0, i - Math.round((M2_WIN_MS / 1000) * SR)), i));
    const v = policy.verdictFromScores({
      candidate: cand.word, m1Score: Number(cand.score) || 0, m1How: cand.how,
      scored: matcher.scoreAll(m2txt, words), thresholdOf: () => 0.7,
    });
    if (v.action === 'fire' || v.action === 'swap') {
      fired.add(cand.word);
      decided = true;
      return { fired: true, acted: v.word, rule: v.rule, m1: cand, m2: m2txt };
    }
    decided = true;   // 本轮静音已判否
  }
  return { fired: false, acted: null, rule: 'none' };
}

(async () => {
  const files = fs.readdirSync(cap).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  console.log('  素材: ' + cap + '  条数 ' + files.length);
  const t = await teacher.transcribeMany(files.map((f) => path.join(cap, f)));
  if (!t.ok) { console.log('  老师失败: ' + t.error); return; }
  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
  let kw = 0;
  let correct = 0;
  let wrong = 0;
  let miss = 0;
  let fp = 0;
  const rows = [];
  for (const f of files) {
    const tt = t.results[f] || '';
    const expected = words.filter((w) => norm(tt).includes(norm(w.word))).map((w) => w.word);
    const wav = readWav(path.join(cap, f));
    const r = runSilence(wav.samples || wav);
    if (expected.length) {
      kw += 1;
      if (!r.acted) miss += 1;
      else if (expected.some((e) => r.acted === e || samePlan(r.acted, e))) correct += 1;
      else wrong += 1;
    } else if (r.acted) fp += 1;
    rows.push({ f, tt, expected, r });
  }
  console.log('');
  console.log('  === 新算法（静音帧匹配） ===');
  console.log('  有关键词的录音: ' + kw + '   正确 ' + correct + '   错词 ' + wrong + '   漏响 ' + miss);
  console.log('  误触发（老师没词却执行）: ' + fp);
  console.log('  录音级召回: ' + correct + '/' + kw + ' = ' + (kw ? (correct / kw * 100).toFixed(1) : '0') + '%');
  for (const x of rows.filter((y) => y.expected.length && !y.r.acted).slice(0, 8)) console.log('    漏: ' + x.f + ' 老师「' + x.tt + '」');
})();
