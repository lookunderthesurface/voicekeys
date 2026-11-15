// 评测"确认模型"候选：加载耗时 / 内存 / 推理 / 空闲自旋 CPU / 准确率
//
//   node scripts/bench-confirmer2.cjs <模型目录> <线程数>
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));
const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { matchOne } = require(path.join(ROOT, 'app', 'matcher.js'));

const DIR = process.argv[2];
const THREADS = Number(process.argv[3] || 1);
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: JSON.stringify((p.plan && p.plan.steps) || []) }));
const CALIB = path.join(require('../app/config.js').DIRS.root, 'calib');

const rss = () => Math.round(process.memoryUsage().rss / 1048576);

function modelConfig() {
  const files = fs.readdirSync(DIR);
  const pick = (re) => files.find((f) => re.test(f));
  const base = { tokens: path.join(DIR, 'tokens.txt'), numThreads: THREADS, provider: 'cpu', debug: 0 };
  const single = pick(/^model\.int8\.onnx$/) || pick(/^model\.onnx$/);
  const enc = pick(/encoder.*\.int8\.onnx$/) || pick(/encoder.*\.onnx$/);
  if (single && files.includes('am.mvn')) return { ...base, paraformer: { model: path.join(DIR, single) } };
  if (single && !enc) return { ...base, senseVoice: { model: path.join(DIR, single), useInverseTextNormalization: 1 } };
  if (enc) {
    const dec = pick(/decoder.*\.int8\.onnx$/) || pick(/decoder.*\.onnx$/);
    const joi = pick(/joiner.*\.int8\.onnx$/) || pick(/joiner.*\.onnx$/);
    if (joi) return { ...base, transducer: { encoder: path.join(DIR, enc), decoder: path.join(DIR, dec), joiner: path.join(DIR, joi) } };
    return { ...base, zipformer2Ctc: { model: path.join(DIR, enc) } };
  }
  throw new Error('认不出模型类型: ' + files.join(','));
}

async function main() {
  const t0 = Date.now();
  const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: modelConfig() });
  const loadMs = Date.now() - t0;
  const rssAfter = rss();

  // 空闲自旋：真正睡眠 10 秒（busy-wait 会把测量自己算进去）
  const c0 = process.cpuUsage();
  const w0 = Date.now();
  await new Promise((r) => setTimeout(r, 10000));
  const c1 = process.cpuUsage();
  const idleCpuPct = (((c1.user + c1.system) - (c0.user + c0.system)) / 1000) / ((Date.now() - w0) / 1000) * 100;

  let total = 0;
  let hit = 0;
  const misses = [];
  let inferTotal = 0;
  for (const dir of fs.readdirSync(CALIB)) {
    const d = path.join(CALIB, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    if (!words.some((w) => w.word === dir)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.wav')).sort()) {
      const pcm = readWav(path.join(d, f));
      const a = Date.now();
      const st = rec.createStream();
      st.acceptWaveform({ sampleRate: 16000, samples: pcm });
      rec.decode(st);
      const text = (rec.getResult(st).text || '').trim();
      inferTotal += Date.now() - a;
      const m = matchOne(text, words, { threshold: 0.7 });
      total += 1;
      if (m && !m.ambiguous && m.word === dir) hit += 1;
      else misses.push(dir + '→' + (text || '空'));
    }
  }

  console.log(JSON.stringify({
    model: path.basename(DIR),
    threads: THREADS,
    loadMs,
    rssMB: rssAfter,
    idleCpuPct: Number(idleCpuPct.toFixed(1)),
    avgInferMs: Math.round(inferTotal / Math.max(1, total)),
    accuracy: hit + '/' + total,
    percent: Math.round((hit / total) * 100),
    misses: misses.slice(0, 5),
  }));
  process.exit(0);
}

main().catch((e) => { console.log('  失败: ' + e.message); process.exit(1); });
