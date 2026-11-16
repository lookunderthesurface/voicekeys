// 更忠实地回放：M1 在"第一次喊完那一刻"到底看到了什么？
// 做法：把音频截到第 1 段结束 + 静音尾巴（运行时 M1 是连续流，前面有静音/上下文），再喂给 M1。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const paths = require(path.join(ROOT, 'app', 'paths.js'));
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const { readWav } = require(path.join(paths.pluginRoot(), 'runtime', 'listener', 'audio.cjs'));
const sherpa = require(path.join(paths.packageDir('sherpa-onnx-node') || '', 'node_modules', 'sherpa-onnx-node'));

const ASR = path.join(config.DIRS.models, 'asr');
const M1_DIR = path.join(ASR, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const M2_DIR = path.join(ASR, 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const CAP = config.DIRS.capture;
const files = ['seg-0064.wav', 'seg-0404.wav', 'seg-0455.wav', 'seg-0468.wav'];
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: p.say }));

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

function m1Stream(pcm) {
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
    if (flags[k]) { if (start < 0) start = k; lastVoice = k; }
    else if (start >= 0 && k - lastVoice > 3) { segs.push([start, lastVoice + 1]); start = -1; }
  }
  if (start >= 0) segs.push([start, lastVoice + 1]);
  return segs.filter(([a, b]) => b - a >= 2);
}

const silence = (ms) => new Float32Array(Math.round((ms / 1000) * 16000));

console.log('  M1 在"第一次喊完那一刻"的输出（前面带上真实上下文 + 600ms 静音尾巴）');
for (const f of files) {
  const file = path.join(CAP, f);
  if (!fs.existsSync(file)) continue;
  const wav = readWav(file);
  const pcm = wav.samples || wav;
  const segs = segments(pcm);
  if (segs.length < 2) { console.log('\n  ' + f + '：只切出 ' + segs.length + ' 段，跳过'); continue; }
  const [a1, b1] = segs[0];
  const [a2, b2] = segs[1];
  console.log('');
  console.log('  === ' + f + ' ===');
  console.log('    第1段 ' + ((b1 - a1) * 0.1).toFixed(1) + 's，第2段 ' + ((b2 - a2) * 0.1).toFixed(1) + 's');

  // ① 只喂第1段（前面没上下文）
  const just1 = pcm.subarray(a1 * 1600, b1 * 1600);
  // ② 从片段开头喂到第1段结束 + 600ms 静音（模拟运行时"喊完等静音门"那一刻）
  const prefix1 = Float32Array.from([...pcm.subarray(0, b1 * 1600), ...silence(600)]);
  // ③ 喂到第2段结束 + 600ms 静音（对比第二次为什么成了）
  const prefix2 = Float32Array.from([...pcm.subarray(0, b2 * 1600), ...silence(600)]);

  const t1a = m1Stream(just1);
  const t1b = m1Stream(prefix1);
  const t2b = m1Stream(prefix2);
  const cand = (t) => {
    const c = matcher.matchAtEnd(t, words, { threshold: 0.15 });
    return c && !c.ambiguous ? '候选「' + c.word + '」' + Number(c.score).toFixed(2) : '无候选';
  };
  console.log('    ① M1 只听第1段            ：「' + t1a + '」  → ' + cand(t1a));
  console.log('    ② M1 听(上下文+第1段+静音)：「' + t1b + '」  → ' + cand(t1b));
  console.log('    ③ M1 听(上下文+两段+静音)  ：「' + t2b + '」  → ' + cand(t2b));
  console.log('    M2 听第1段：「' + m2Text(just1) + '」');
}
