// 真实语音基准测试：把一整批 wav 逐条"当场喂"给整条流水线
//   M1 流式识别 → 候选 → 600ms 静音门 → M2 裁决 → 执行/丢弃
//
// 用途：
//   ① 误触发基准：喂不含命令词的真实语音（THCHS-30 朗读语料），统计触发次数/每小时
//   ② 召回基准：喂含命令词的录音（我们的 capture 素材），统计正确执行率
//
// 用法：
//   node test/bench-corpus.cjs <wav目录> [--limit N] [--teacher]
//     --limit    只测前 N 条（快速试跑）
//     --teacher  对每一条"触发了"的音频再用 1.7B 老师复核，区分"真出现词"还是"纯幻听"
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const paths = require(path.join(ROOT, 'app', 'paths.js'));
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const policy = require(path.join(ROOT, 'app', 'pipeline', 'policy.js'));
const { readWav } = require(path.join(paths.pluginRoot(), 'runtime', 'listener', 'audio.cjs'));
const sherpa = require(path.join(paths.packageDir('sherpa-onnx-node') || '', 'node_modules', 'sherpa-onnx-node'));

const ASR = path.join(config.DIRS.models, 'asr');
const M1_DIR = path.join(ASR, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const M2_DIR = path.join(ASR, 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const SR = 16000;
const FRAME = 1600;
const PAUSE_MS = 600;
const TAIL_MS = 1200;          // 每条后面补的静音（模拟"说完停住"）
const M1_TH = 0.7;
const M2_TH = 0.7;
const M2_WINDOW_MS = 6000;

const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: p.say }));

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

/** 跑一条音频，返回触发结果或 null */
function runOne(pcm) {
  const total = new Float32Array(pcm.length + Math.round((TAIL_MS / 1000) * SR));
  total.set(pcm, 0);
  const st = m1.createStream();
  let pending = null;
  let fireAt = -1;
  let fireCand = null;
  for (let i = 0; i + FRAME <= total.length; i += FRAME) {
    st.acceptWaveform({ sampleRate: SR, samples: total.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
    const text = (m1.getResult(st).text || '').trim();
    if (!pending) {
      const cand = propose(text);
      if (cand) pending = { cand, at: i };
    }
    if (pending && ((i - pending.at) / SR) * 1000 >= PAUSE_MS) { fireAt = i; fireCand = pending.cand; break; }
    if (m1.isEndpoint(st)) m1.reset(st);
  }
  if (fireAt < 0) return null;
  const winStart = Math.max(0, fireAt - Math.round((M2_WINDOW_MS / 1000) * SR));
  const win = total.subarray(winStart, fireAt);
  let txt = '';
  try {
    if (process.env.VK_BENCH_DEBUG) console.log('    [fire] frame=' + fireAt + ' winLen=' + win.length + ' cand=' + fireCand.word);
    txt = m2Text(win);
  } catch (e) {
    if (process.env.VK_BENCH_DEBUG) console.log('    [m2 异常] ' + e.message + ' winLen=' + win.length);
  }
  const v = policy.verdictFromScores({
    candidate: fireCand.word, m1Score: Number(fireCand.score) || 0, m1How: fireCand.how,
    scored: matcher.scoreAll(txt, words), thresholdOf: () => M2_TH,
  });
  const acted = (v.action === 'fire' || v.action === 'swap') ? v.word : null;
  return { fireAt, cand: fireCand, m2: txt, verdict: v, acted };
}

(async () => {
  const dir = process.argv[2];
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 0;
  const useTeacher = process.argv.includes('--teacher');
  const expectIdx = process.argv.indexOf('--expect');
  const expectWord = expectIdx > 0 ? String(process.argv[expectIdx + 1] || '') : '';
  if (!dir || !fs.existsSync(dir)) { console.log('用法: node test/bench-corpus.cjs <wav目录> [--limit N] [--teacher]'); process.exit(1); }
  let files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  if (limit) files = files.slice(0, limit);
  console.log('  语料: ' + dir);
  console.log('  条数: ' + files.length + '；命令词表 ' + words.length + ' 个');

  let secs = 0;
  let triggers = 0;
  let fires = 0;
  let skipped = 0;
  const hits = [];
  for (let k = 0; k < files.length; k += 1) {
    let pcm;
    try {
      const wav = readWav(path.join(dir, files[k]));
      pcm = wav.samples || wav;
    } catch {
      skipped += 1;
      continue;
    }
    secs += pcm.length / SR;
    let r = null;
    try { r = runOne(pcm); } catch { r = null; }
    if (r) fires += 1;
    if (r && r.acted) {
      triggers += 1;
      hits.push({ file: files[k], ...r });
    }
    if ((k + 1) % 100 === 0) console.log('  进度 ' + (k + 1) + '/' + files.length + '，已触发 ' + triggers);
  }

  console.log('');
  console.log('  === 结果 ===');
  if (expectWord) {
    const planOf = new Map(planner.listVerbose().map((p) => [p.say, JSON.stringify((p.plan && p.plan.steps) || [])]));
    const samePlan = (a, b) => a && b && planOf.get(a) === planOf.get(b);
    const ok = hits.filter((h) => h.acted === expectWord || samePlan(h.acted, expectWord));
    const wrong = hits.filter((h) => !(h.acted === expectWord || samePlan(h.acted, expectWord)));
    console.log('  【召回】目标词「' + expectWord + '」正确执行 ' + ok.length + ' / ' + files.length + ' = ' + (ok.length / files.length * 100).toFixed(1) + '%');
    console.log('  【错词】被听成别的词 ' + wrong.length + ' 条');
  }
  console.log('  音频总长: ' + (secs / 60).toFixed(1) + ' 分钟' + (skipped ? '（跳过 ' + skipped + ' 条读不了的）' : ''));
  console.log('  门到期次数(候选被提出): ' + fires + ' / ' + files.length + ' 条');
  console.log('  执行动作次数: ' + triggers + ' / ' + files.length + ' 条');
  console.log('  触发率: ' + (triggers / files.length * 100).toFixed(2) + '%');
  console.log('  每小时触发: ' + (triggers / (secs / 3600)).toFixed(1) + ' 次/小时');
  for (const h of hits.slice(0, 30)) {
    console.log('    ' + h.file + '  执行「' + h.acted + '」 候选「' + h.cand.word + '」' + Number(h.cand.score).toFixed(2) + '(' + h.cand.how + ')  M2「' + h.m2 + '」 [' + h.verdict.rule + ']');
  }

  if (useTeacher && hits.length) {
    console.log('');
    console.log('  === 老师复核（看这些音频里到底有没有出现命令词） ===');
    const teacher = require(path.join(ROOT, 'app', 'teacher.js'));
    const t = await teacher.transcribeMany(hits.map((h) => path.join(dir, h.file)));
    if (!t.ok) { console.log('  老师失败: ' + t.error); return; }
    const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
    let real = 0;
    for (const h of hits) {
      const text = t.results[h.file] || '';
      const has = words.some((w) => norm(text).includes(norm(w.word)));
      if (has) real += 1;
      console.log('    ' + h.file + '  老师「' + text + '」  ' + (has ? '← 句子里确实出现了命令词' : '← 纯幻听'));
    }
    console.log('  触发里"真的出现了命令词": ' + real + ' / ' + hits.length);
  }
})();
