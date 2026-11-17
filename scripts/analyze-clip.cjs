// 分析一条真实素材：把音频按能量切段，逐段用 M1 / M2 / 1.7B 老师各自打分
// 用途：搞清楚"第一次喊没触发、第二次触发"到底是哪一层的分数不够
// 用法：node scripts/analyze-clip.cjs <wav文件> [目标词...]
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const paths = require(path.join(ROOT, 'app', 'paths.js'));
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const teacher = require(path.join(ROOT, 'app', 'teacher.js'));
const { readWav } = require(path.join(paths.pluginRoot(), 'runtime', 'listener', 'audio.cjs'));
const sherpa = require(path.join(paths.packageDir('sherpa-onnx-node') || '', 'node_modules', 'sherpa-onnx-node'));

const ASR = path.join(config.DIRS.models, 'asr');
const M1_DIR = path.join(ASR, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const M2_DIR = path.join(ASR, 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const SR = 16000;
const FRAME = 1600;

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.log('用法: node scripts/analyze-clip.cjs <wav> [目标词...]'); process.exit(1); }
const targets = process.argv.slice(3);
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

function m1Text(pcm) {
  const st = m1.createStream();
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    st.acceptWaveform({ sampleRate: SR, samples: pcm.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
  }
  st.inputFinished();
  while (m1.isReady(st)) m1.decode(st);
  return (m1.getResult(st).text || '').trim();
}
function m2Text(pcm) {
  const st = m2.createStream();
  st.acceptWaveform({ sampleRate: SR, samples: pcm });
  m2.decode(st);
  return (m2.getResult(st).text || '').trim();
}
function propose(text) {
  if (!text) return null;
  const endMatch = matcher.matchAtEnd(text, words, { threshold: 0.7 });
  if (endMatch && !endMatch.ambiguous && endMatch.score >= 0.7) return { word: endMatch.word, score: endMatch.score, how: endMatch.how };
  const best = matcher.bestScore(text, words);
  if (!best || best.score < 0.15) return null;
  return { word: best.word, score: best.score, how: best.how || 'loose' };
}
function writeWav(file2, pcm) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i += 1) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file2, buf);
}
function segments(pcm) {
  const frame = FRAME;
  const flags = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let s = 0;
    for (let j = 0; j < frame; j += 1) s += pcm[i + j] * pcm[i + j];
    flags.push(Math.sqrt(s / frame) > 0.02);
  }
  const segs = [];
  let start = -1;
  let lastVoice = -1;
  for (let k = 0; k < flags.length; k += 1) {
    if (flags[k]) { if (start < 0) start = k; lastVoice = k; }
    else if (start >= 0 && k - lastVoice > 3) { segs.push([start, lastVoice + 1]); start = -1; }
  }
  if (start >= 0) segs.push([start, lastVoice + 1]);
  return segs.filter(([a, b]) => b - a >= 2).map(([a, b]) => pcm.subarray(a * frame, Math.min(pcm.length, (b + 6) * frame)));
}

(async () => {
  const wav = readWav(file);
  const pcm = wav.samples || wav;
  console.log('  文件: ' + path.basename(file) + '  时长 ' + (pcm.length / SR).toFixed(2) + 's');
  if (targets.length) console.log('  关注词: ' + targets.join(' / '));
  const segs = segments(pcm);
  console.log('  切出 ' + segs.length + ' 段');

  const tmpDir = path.join(ROOT, 'dist', 'clip-segs');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filesForTeacher = [];
  segs.forEach((seg, i) => {
    const p = path.join(tmpDir, path.basename(file, '.wav') + '-seg' + (i + 1) + '.wav');
    writeWav(p, seg);
    filesForTeacher.push(p);
  });

  const t = await teacher.transcribeMany(filesForTeacher);
  const teacherOk = t.ok;

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const t1 = m1Text(seg);
    const c = propose(t1);
    const t2 = m2Text(seg);
    const teacherText = teacherOk ? (t.results[path.basename(filesForTeacher[i])] || '') : '';
    console.log('');
    console.log('  第' + (i + 1) + '段  ' + (seg.length / SR).toFixed(2) + 's');
    console.log('    M1 转写: 「' + t1 + '」' + (c ? '  → 候选「' + c.word + '」 ' + Number(c.score).toFixed(2) + '(' + c.how + ')' : '  → 无候选'));
    console.log('    M2 转写: 「' + t2 + '」');
    const scoreLine = (label, txt) => {
      for (const w of targets.length ? targets : (c ? [c.word] : [])) {
        const s = matcher.scoreAll(txt, [{ word: w }])[0];
        console.log('      ' + label + ' 对「' + w + '」的分数: ' + (s ? s.score.toFixed(2) : '0.00') + '  (' + (s ? s.how : '-') + ')');
      }
    };
    scoreLine('M2', t2);
    if (teacherOk) {
      console.log('    1.7B 老师: 「' + teacherText + '」');
      scoreLine('老师', teacherText);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();
