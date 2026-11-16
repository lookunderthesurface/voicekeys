// 把"喊了多遍"的录音切段，用 M1 / M2 分别重新听一遍：
// 看那一遍"没触发"的音频，两个模型各自认成了什么 —— 这才是能学到东西的地方。
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
const CACHE = path.join(ROOT, 'dist', 'teacher-cache.json');
const CAP = config.DIRS.capture;
const TH = 0.7;

const verbose = planner.listVerbose();
const words = verbose.map((p) => ({ word: p.say, planKey: p.say }));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');

// 找出"老师听到同一个词≥2次"的录音
const multi = [];
for (const [file, text] of Object.entries(cache)) {
  const t = norm(text);
  if (!t) continue;
  for (const w of words) {
    const key = norm(w.word);
    const times = t.split(key).length - 1;
    if (times >= 2) { multi.push({ file, word: w.word, times, text }); break; }
  }
}

const m1 = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
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
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    paraformer: { model: path.join(M2_DIR, 'model.int8.onnx') },
    tokens: path.join(M2_DIR, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0,
  },
});

function m1Text(pcm) {
  const st = m1.createStream();
  for (let i = 0; i + 1600 <= pcm.length; i += 1600) {
    st.acceptWaveform({ sampleRate: 16000, samples: pcm.subarray(i, i + 1600) });
    while (m1.isReady(st)) m1.decode(st);
  }
  st.inputFinished();
  while (m1.isReady(st)) m1.decode(st);
  return (m1.getResult(st).text || '').trim();
}
function m2Text(pcm) {
  const st = m2.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples: pcm });
  m2.decode(st);
  return (m2.getResult(st).text || '').trim();
}

/** 按能量切出有声段（100ms 帧，>0.02 算有声，间隔 ≤300ms 合并，最短 200ms） */
function segments(pcm) {
  const frame = 1600;
  const flags = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let ps = 0;
    for (let j = 0; j < frame; j += 1) ps += pcm[i + j] * pcm[i + j];
    flags.push(Math.sqrt(ps / frame) > 0.02);
  }
  const segs = [];
  let start = -1;
  let lastVoice = -1;
  for (let k = 0; k < flags.length; k += 1) {
    if (flags[k]) {
      if (start < 0) start = k;
      lastVoice = k;
    } else if (start >= 0 && k - lastVoice > 3) {
      segs.push([start, lastVoice + 1]);
      start = -1;
    }
  }
  if (start >= 0) segs.push([start, lastVoice + 1]);
  return segs
    .filter(([a, b]) => b - a >= 2)
    .map(([a, b]) => pcm.subarray(a * frame, Math.min(pcm.length, b * frame)));
}

console.log('  找到 ' + multi.length + ' 条"同词≥2次"的录音');
for (const m of multi) {
  const file = path.join(CAP, m.file);
  if (!fs.existsSync(file)) { console.log('    ' + m.file + ' 文件不存在'); continue; }
  const wav = readWav(file);
  const pcm = wav.samples || wav;
  const segs = segments(pcm);
  console.log('');
  console.log('  === ' + m.file + '  词「' + m.word + '」 老师听到 ' + m.times + ' 次 ===');
  console.log('      老师全文：「' + m.text + '」');
  console.log('      切出 ' + segs.length + ' 段有声区间');
  segs.forEach((seg, idx) => {
    const dur = (seg.length / 16000).toFixed(2);
    const t1 = m1Text(seg);
    const t2 = m2Text(seg);
    const cand = matcher.matchAtEnd(t1, words, { threshold: 0.15 });
    console.log('      第 ' + (idx + 1) + ' 段 ' + dur + 's');
    console.log('         M1 听到：「' + t1 + '」' + (cand ? '  → 候选「' + cand.word + '」' + Number(cand.score).toFixed(2) : '  → 无候选'));
    console.log('         M2 听到：「' + t2 + '」');
    if (cand && !cand.ambiguous) {
      const v = policy.verdictFromScores({
        candidate: cand.word, m1Score: Number(cand.score) || 0,
        scored: matcher.scoreAll(t2, words), thresholdOf: () => TH,
      });
      console.log('         按现在的裁决: ' + (v.action === 'drop' ? '丢弃' : '执行「' + (v.word || '') + '」') + '  [' + v.rule + '] ' + v.why);
    }
  });
}
