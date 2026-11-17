// 老师监督分母的召回基准：
//   分母 = 1.7B 老师确认"确实说了目标词"的条数（Hi-MIA 有标签噪声，必须老师过滤）
//   分子 = 流水线正确执行目标词的条数
// 用法：node test/bench-teacher-denom.cjs <wav目录> <目标词> [--limit N]
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
const PAUSE_MS = 600;
const TAIL_MS = 1200;
const M1_TH = 0.7;
const M2_TH = 0.7;
const TEACHER_TH = 0.7;

const dir = process.argv[2];
const target = process.argv[3];
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 0;
if (!dir || !target || !fs.existsSync(dir)) {
  console.log('用法: node test/bench-teacher-denom.cjs <wav目录> <目标词> [--limit N]');
  process.exit(1);
}

const verbose = planner.listVerbose();
const words = verbose.map((p) => ({ word: p.say, planKey: p.say }));
const planOf = new Map(verbose.map((p) => [p.say, JSON.stringify((p.plan && p.plan.steps) || [])]));
const samePlan = (a, b) => a && b && planOf.get(a) === planOf.get(b);
const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');

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

function propose(text) {
  if (!text) return null;
  const endMatch = matcher.matchAtEnd(text, words, { threshold: M1_TH });
  if (endMatch && !endMatch.ambiguous && endMatch.score >= M1_TH) return { word: endMatch.word, score: endMatch.score, how: endMatch.how };
  const best = matcher.bestScore(text, words);
  if (!best || best.score < policy.DEFAULT_POLICY.candidateFloor) return null;
  return { word: best.word, score: best.score, how: best.how || 'loose' };
}
function m2Text(pcm) {
  const st = m2.createStream();
  st.acceptWaveform({ sampleRate: SR, samples: pcm });
  m2.decode(st);
  return (m2.getResult(st).text || '').trim();
}

function runPipeline(pcm) {
  const total = new Float32Array(pcm.length + Math.round((TAIL_MS / 1000) * SR));
  total.set(pcm, 0);
  const st = m1.createStream();
  let pending = null;
  let fireAt = -1;
  let fireCand = null;
  let lastText = '';
  for (let i = 0; i + FRAME <= total.length; i += FRAME) {
    st.acceptWaveform({ sampleRate: SR, samples: total.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
    const text = (m1.getResult(st).text || '').trim();
    if (text) lastText = text;
    if (!pending) {
      const cand = propose(text);
      if (cand) pending = { cand, at: i };
    }
    if (pending && ((i - pending.at) / SR) * 1000 >= PAUSE_MS) { fireAt = i; fireCand = pending.cand; break; }
    if (m1.isEndpoint(st)) m1.reset(st);
  }
  if (fireAt < 0) return { fired: false, acted: null, m1Text: lastText };
  const winStart = Math.max(0, fireAt - Math.round((6000 / 1000) * SR));
  const txt = m2Text(total.subarray(winStart, fireAt));
  const v = policy.verdictFromScores({
    candidate: fireCand.word, m1Score: Number(fireCand.score) || 0, m1How: fireCand.how,
    scored: matcher.scoreAll(txt, words), thresholdOf: () => M2_TH,
  });
  return { fired: true, acted: (v.action === 'fire' || v.action === 'swap') ? v.word : null, cand: fireCand, m2: txt, rule: v.rule, m1Text: lastText };
}

(async () => {
  let files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  if (limit) files = files.slice(0, limit);
  console.log('  语料 ' + dir);
  console.log('  条数 ' + files.length + '；目标词「' + target + '」');

  // 1) 老师转写（1.7B，靠 VK_TEACHER_MODEL 指向）
  console.log('  老师转写中…');
  const t = await teacher.transcribeMany(files.map((f) => path.join(dir, f)));
  if (!t.ok) { console.log('  ✘ 老师失败: ' + t.error); return; }
  console.log('  老师加载 ' + (t.loadMs || '?') + 'ms，转写 ' + t.ms + 'ms');

  const teacherHit = new Map();
  let denom = 0;
  for (const f of files) {
    const txt = t.results[f] || '';
    const scored = matcher.scoreAll(txt, [{ word: target }]);
    const score = scored[0] ? scored[0].score : 0;
    const literal = norm(txt).includes(norm(target));
    const hit = literal || score >= TEACHER_TH;
    teacherHit.set(f, { hit, score, text: txt });
    if (hit) denom += 1;
  }
  console.log('  老师确认说了「' + target + '」: ' + denom + ' / ' + files.length);

  // 2) 流水线
  console.log('  流水线回放中…');
  let correct = 0;
  let wrongWord = 0;
  let firedNoAct = 0;
  let noFire = 0;
  let noText = 0;
  const details = [];
  for (let k = 0; k < files.length; k += 1) {
    const f = files[k];
    const info = teacherHit.get(f);
    let pcm;
    try { const w = readWav(path.join(dir, f)); pcm = w.samples || w; } catch { continue; }
    let r;
    try { r = runPipeline(pcm); } catch { r = { fired: false, acted: null, m1Text: '' }; }
    if (info.hit) {
      if (r.acted === target || samePlan(r.acted, target)) correct += 1;
      else if (r.acted) { wrongWord += 1; details.push('错词 ' + f + ' →「' + r.acted + '」 老师「' + info.text + '」'); }
      else if (r.fired) { firedNoAct += 1; details.push('门到M2否决 ' + f + ' 老师「' + info.text + '」 M2「' + (r.m2 || '') + '」 [' + (r.rule || '') + ']'); }
      else { noFire += 1; if (!r.m1Text) noText += 1; details.push('门没到期 ' + f + ' 老师「' + info.text + '」 M1「' + (r.m1Text || '空') + '」'); }
    }
    if ((k + 1) % 200 === 0) console.log('  进度 ' + (k + 1) + '/' + files.length);
  }

  console.log('');
  console.log('  === 老师监督口径 ===');
  console.log('  分母（老师确认说了目标词）: ' + denom);
  console.log('  分子（流水线正确执行）:     ' + correct + ' = ' + (denom ? (correct / denom * 100).toFixed(1) : '0') + '%');
  console.log('  失败分解: 错词 ' + wrongWord + '，门到期但 M2 否决 ' + firedNoAct + '，门没到期 ' + noFire + '（其中 M1 完全没出字 ' + noText + '）');
  console.log('');
  console.log('  失败样例（前 15）:');
  for (const d of details.slice(0, 15)) console.log('    ' + d);
})();
