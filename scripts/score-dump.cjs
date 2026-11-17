// 老师监督 + 分数明细：对每条"老师确认说了目标词"的音频，记录
//   M1 候选/分数/匹配方式、M2 转写与 M2 对目标词的分数、老师对目标词的分数、最终动作
// 最后按"成功 / M2 否决 / 门没到期"分组统计分数分布，用于决定算法怎么改。
// 用法：node scripts/score-dump.cjs <wav目录> <目标词> [--limit N]
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
const TAIL_MS = 1200;
const M1_TH = 0.7;
const M2_TH = 0.7;
const TEACHER_TH = 0.7;

const dir = process.argv[2];
const target = process.argv[3];
if (!dir || !target) { console.log('用法: node scripts/score-dump.cjs <wav目录> <目标词>'); process.exit(1); }

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

function runOne(pcm) {
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
    if (!pending) { const c = propose(text); if (c) pending = { cand: c, at: i }; }
    if (pending && ((i - pending.at) / SR) * 1000 >= 600) { fireAt = i; fireCand = pending.cand; break; }
    if (m1.isEndpoint(st)) m1.reset(st);
  }
  if (fireAt < 0) return { fired: false, m1Text: lastText };
  const winStart = Math.max(0, fireAt - 6000 / 1000 * SR);
  const txt = m2Text(total.subarray(winStart, fireAt));
  const v = policy.verdictFromScores({
    candidate: fireCand.word, m1Score: Number(fireCand.score) || 0, m1How: fireCand.how,
    scored: matcher.scoreAll(txt, words), thresholdOf: () => M2_TH,
  });
  const targetM2 = matcher.scoreAll(txt, [{ word: target }])[0];
  return {
    fired: true, cand: fireCand, m2: txt, rule: v.rule,
    acted: (v.action === 'fire' || v.action === 'swap') ? v.word : null,
    m2TargetScore: targetM2 ? targetM2.score : 0,
  };
}

function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '0%'; }
function hist(values) {
  const buckets = { '<0.5': 0, '0.5': 0, '0.67': 0, '0.75': 0, '0.85': 0, '1.0': 0, '???': 0 };
  for (const v of values) {
    if (v >= 0.999) buckets['1.0'] += 1;
    else if (Math.abs(v - 0.85) < 0.03) buckets['0.85'] += 1;
    else if (Math.abs(v - 0.75) < 0.03) buckets['0.75'] += 1;
    else if (Math.abs(v - 0.67) < 0.03) buckets['0.67'] += 1;
    else if (Math.abs(v - 0.5) < 0.03) buckets['0.5'] += 1;
    else if (v < 0.5) buckets['<0.5'] += 1;
    else buckets['???'] += 1;
  }
  return JSON.stringify(buckets);
}

(async () => {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  console.log('  语料 ' + dir + '  条数 ' + files.length + '  目标词「' + target + '」');
  console.log('  老师转写中…');
  const t = await teacher.transcribeMany(files.map((f) => path.join(dir, f)));
  if (!t.ok) { console.log('  ✘ 老师失败: ' + t.error); return; }

  const rows = [];
  for (let k = 0; k < files.length; k += 1) {
    const f = files[k];
    const teacherText = t.results[f] || '';
    const ts = matcher.scoreAll(teacherText, [{ word: target }])[0];
    const teacherScore = ts ? ts.score : 0;
    const teacherHit = teacherScore >= TEACHER_TH;
    if (!teacherHit) continue;
    let pcm;
    try { const w = readWav(path.join(dir, f)); pcm = w.samples || w; } catch { continue; }
    let r;
    try { r = runOne(pcm); } catch { r = { fired: false }; }
    rows.push({
      file: f, teacherText, teacherScore,
      fired: r.fired, m1: r.cand ? r.cand.word : '', m1Score: r.cand ? Number(r.cand.score) : 0, m1How: r.cand ? r.cand.how : '',
      m2: r.m2 || '', m2TargetScore: r.m2TargetScore || 0, acted: r.acted || null, rule: r.rule || '',
    });
  }

  const ok = rows.filter((x) => x.acted && (x.acted === target || samePlan(x.acted, target)));
  const veto = rows.filter((x) => x.fired && !(x.acted && (x.acted === target || samePlan(x.acted, target))));
  const miss = rows.filter((x) => !x.fired);
  console.log('');
  console.log('  === 汇总（分母=老师确认 ' + rows.length + ' 条） ===');
  console.log('  正确 ' + ok.length + ' / ' + rows.length + ' = ' + pct(ok.length, rows.length));
  console.log('  门到期但没执行: ' + veto.length);
  console.log('  门没到期: ' + miss.length);
  console.log('');
  console.log('  === M2 否决/未执行的 ' + veto.length + ' 条：M1 分数分布 ===');
  console.log('    M1分数: ' + hist(veto.map((x) => x.m1Score)));
  console.log('    M1匹配方式: ' + JSON.stringify(veto.reduce((a, x) => { a[x.m1How || '?'] = (a[x.m1How || '?'] || 0) + 1; return a; }, {})));
  console.log('    M2 对目标词分数: ' + hist(veto.map((x) => x.m2TargetScore)));
  console.log('    老师对目标词分数: ' + hist(veto.map((x) => x.teacherScore)));
  console.log('');
  console.log('  === 成功的 ' + ok.length + ' 条：M1 分数分布（对照） ===');
  console.log('    M1分数: ' + hist(ok.map((x) => x.m1Score)));
  console.log('    M2 对目标词分数: ' + hist(ok.map((x) => x.m2TargetScore)));
  console.log('');
  console.log('  === 否决样例（前 12 条） ===');
  for (const x of veto.slice(0, 12)) {
    console.log('    ' + x.file + '  M1「' + x.m1 + '」' + x.m1Score.toFixed(2) + '(' + x.m1How + ')  M2「' + x.m2 + '」目标分 ' + x.m2TargetScore.toFixed(2) + '  老师「' + x.teacherText + '」' + x.teacherScore.toFixed(2) + '  [' + x.rule + ']');
  }
})();
