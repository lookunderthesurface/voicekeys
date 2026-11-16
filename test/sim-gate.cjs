// 离线模拟：用真实录音回放 M1（逐帧、带端点重置，和运行时一致），
// 对比"旧门"和"新门（候选更新就重置计时、不再匹配就取消）"对召回率/误判率的影响。
//
// 说明：录音在"触发那一刻"结束（旧素材没有触发后尾巴），所以回放时补 600ms 静音，
// 代表"用户说完就停下来了"；否则门永远等不到到期时刻。
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
const CAP = path.join(process.env.LOCALAPPDATA || '', 'VoiceKeys', 'capture-legacy-4s');
const CACHE17 = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'teacher-cache-1.7b.json'), 'utf8'));
const EXCLUDE = new Set(['seg-0069.wav']);
const SR = 16000;
const FRAME = 1600;
const VOICE_RMS = 0.02;
const PAUSE_MS = 600;
const M1_TH = 0.7;
const M2_TH = 0.7;

const verbose = planner.listVerbose();
const words = verbose.map((p) => ({ word: p.say, planKey: p.say }));
const planOf = new Map(verbose.map((p) => [p.say, JSON.stringify((p.plan && p.plan.steps) || [])]));
const live = new Set(verbose.map((p) => p.say));
const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
const samePlan = (a, b) => a && b && planOf.get(a) === planOf.get(b);

function truthOf(text) {
  const t = norm(text);
  if (!t) return { word: null, times: 0 };
  const hits = words.filter((w) => t.includes(norm(w.word))).sort((a, b) => norm(b.word).length - norm(a.word).length);
  if (hits.length) return { word: hits[0].word, times: t.split(norm(hits[0].word)).length - 1 };
  const top = matcher.scoreAll(t, words)[0];
  if (top && top.score >= 0.7) return { word: top.word, times: 1 };
  return { word: null, times: 0 };
}

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
  if (endMatch && !endMatch.ambiguous && endMatch.score >= M1_TH) {
    return { word: endMatch.word, score: endMatch.score, how: endMatch.how };
  }
  const best = matcher.bestScore(text, words);
  if (!best || !(best.score >= policy.DEFAULT_POLICY.candidateFloor)) return null;
  return { word: best.word, score: best.score, how: best.how || 'loose' };
}

function replay(pcm) {
  const st = m1.createStream();
  const steps = [];
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    st.acceptWaveform({ sampleRate: SR, samples: pcm.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
    const text = (m1.getResult(st).text || '').trim();
    steps.push({ text, cand: propose(text), endSample: i + FRAME });
    if (m1.isEndpoint(st)) m1.reset(st);
  }
  return steps;
}
function m2Text(pcm) {
  const st = m2.createStream();
  st.acceptWaveform({ sampleRate: SR, samples: pcm });
  m2.decode(st);
  return (m2.getResult(st).text || '').trim();
}

// 旧门：第一次出现候选就固定 600ms 到期；不取消
function gateOld(steps) {
  let pending = null;
  for (let i = 0; i < steps.length; i += 1) {
    if (!pending && steps[i].cand) pending = { cand: steps[i].cand, at: i };
    if (pending && (i - pending.at) * 100 >= PAUSE_MS) return { i, cand: pending.cand };
  }
  return null;
}
// 新门：候选变化就重置；没候选就取消
function gateNew(steps) {
  let pending = null;
  let lastText = null;
  for (let i = 0; i < steps.length; i += 1) {
    const st = steps[i];
    if (!st.cand) { pending = null; lastText = st.text; continue; }
    const changed = st.text !== lastText || !pending;
    if (changed) pending = { cand: st.cand, at: i };
    lastText = st.text;
    if ((i - pending.at) * 100 >= PAUSE_MS) return { i, cand: pending.cand };
  }
  return null;
}

(async () => {
  const rows = fs.readFileSync(path.join(CAP, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const usable = rows.filter((r) => live.has(r.ourText) && !EXCLUDE.has(r.file) && fs.existsSync(path.join(CAP, r.file)));
  console.log('  素材 ' + usable.length + ' 条（每条尾部补 600ms 静音）');

  const cache = [];
  for (const r of usable) {
    const wav = readWav(path.join(CAP, r.file));
    const base = wav.samples || wav;
    const pcm = new Float32Array(base.length + Math.round(0.6 * SR));
    pcm.set(base, 0);
    cache.push({ r, pcm, steps: replay(pcm), truth: truthOf(CACHE17[r.file] || '') });
  }
  console.log('  回放完成');

  for (const [name, gate] of [['旧门（第一次候选即固定 600ms）', gateOld], ['新门（候选更新就重置 + 不再匹配就取消）', gateNew]]) {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    const notes = [];
    for (const c of cache) {
      const fire = gate(c.steps);
      let acted = null;
      let info = '';
      if (fire) {
        const win = c.pcm.subarray(0, fire.i * FRAME);
        const txt = m2Text(win);
        const scored = matcher.scoreAll(txt, words);
        const v = policy.verdictFromScores({
          candidate: fire.cand.word, m1Score: Number(fire.cand.score) || 0, m1How: fire.cand.how,
          scored, thresholdOf: () => M2_TH,
        });
        acted = (v.action === 'fire' || v.action === 'swap') ? v.word : null;
        info = '候选「' + fire.cand.word + '」→ M2「' + txt + '」→ ' + (acted || '丢弃') + '[' + v.rule + ']';
      }
      if (c.truth.word) {
        if (acted && (acted === c.truth.word || samePlan(acted, c.truth.word))) tp += 1;
        else { fn += 1; notes.push('漏 ' + c.r.file + ' 应「' + c.truth.word + '」 ' + info); }
      } else if (acted) { fp += 1; notes.push('误 ' + c.r.file + ' 执行「' + acted + '」 ' + info); }
      else tn += 1;
    }
    const denom = tp + fn + fp;
    console.log('');
    console.log('  === ' + name + ' ===');
    console.log('    正确 ' + tp + '  漏 ' + fn + '  误触发 ' + fp + '  正确静默 ' + tn);
    console.log('    召回(含误触发当分母) ' + (tp / denom * 100).toFixed(1) + '%   误触发率 ' + (fp / denom * 100).toFixed(1) + '%');
    for (const n of notes.slice(0, 10)) console.log('      ' + n);
  }
})();
