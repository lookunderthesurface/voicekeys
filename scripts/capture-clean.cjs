// 采集数据清理：可反复用的脚本，也是 GUI/自动清理调用的同一份逻辑
//
// 判定"废数据"的依据（都来自实测踩坑）：
//   1. 6 秒满段（MAX_MS 顶格）——早期切句 bug 的产物，通常不含完整一句话
//   2. 转写为空——我们完全没听出任何东西
//   3. 文件缺失
//   4. 音频本身没有语音（峰值过低 / 有声 < 300ms）
//
// 用法：
//   node scripts/capture-clean.cjs            # 只看，不删
//   node scripts/capture-clean.cjs --apply    # 真删
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
let readWav = null;
try { ({ readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'))); } catch { /* 没有也能跑 */ }

const CAPTURE = process.env.VK_CAPTURE_DIR || require('../app/config.js').DIRS.capture;
const APPLY = process.argv.includes('--apply');

function audioQuality(file) {
  if (!readWav || !fs.existsSync(file)) return null;
  try {
    const s = readWav(file);
    let peak = 0;
    let voiced = 0;
    for (let i = 0; i + 1600 <= s.length; i += 1600) {
      let ps = 0;
      for (let j = 0; j < 1600; j += 1) ps += s[i + j] * s[i + j];
      const rms = Math.sqrt(ps / 1600);
      if (rms > peak) peak = rms;
      if (rms > 0.03) voiced += 1;
    }
    return { peak, voicedMs: voiced * 100, durMs: Math.round((s.length / 16000) * 1000) };
  } catch {
    return null;
  }
}

/** 返回 { junk: [{entry, reason}], keep: [entry] } */
function classify(dir = CAPTURE) {
  const indexFile = path.join(dir, 'index.jsonl');
  if (!fs.existsSync(indexFile)) return { junk: [], keep: [], total: 0 };
  const rows = fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const junk = [];
  const keep = [];
  for (const e of rows) {
    const file = path.join(dir, e.file || '');
    if (!e.file || !fs.existsSync(file)) { junk.push({ entry: e, reason: '文件缺失' }); continue; }
    if (!e.ourText) { junk.push({ entry: e, reason: '转写为空' }); continue; }
    if (Math.round((e.ms || 0) / 1000) >= 6) { junk.push({ entry: e, reason: '6 秒满段' }); continue; }
    const q = audioQuality(file);
    if (q && (q.peak < 0.02 || q.voicedMs < 300)) { junk.push({ entry: e, reason: `音频无语音(峰值${q.peak.toFixed(3)}/有声${q.voicedMs}ms)` }); continue; }
    keep.push(e);
  }
  return { junk, keep, total: rows.length };
}

/** 真删：删文件 + 重写 index */
function prune(dir = CAPTURE) {
  const { junk, keep } = classify(dir);
  for (const j of junk) {
    try { fs.unlinkSync(path.join(dir, j.entry.file)); } catch { /* ignore */ }
  }
  const indexFile = path.join(dir, 'index.jsonl');
  fs.writeFileSync(indexFile, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
  return { removed: junk.length, kept: keep.length, reasons: junk.map((j) => j.reason) };
}

module.exports = { classify, prune };

if (require.main === module) {
  const { junk, keep, total } = classify();
  console.log('  采集目录: ' + CAPTURE);
  console.log('  总数 ' + total + ' → 废 ' + junk.length + ' / 留 ' + keep.length);
  const byReason = {};
  for (const j of junk) {
    const key = j.reason.replace(/\(.*/, '');
    byReason[key] = (byReason[key] || 0) + 1;
  }
  console.log('  原因: ' + JSON.stringify(byReason));
  for (const j of junk.slice(0, 12)) {
    console.log('    ' + j.entry.id + '  ' + j.reason + '  「' + (j.entry.ourText || '') + '」');
  }
  if (junk.length > 12) console.log('    …还有 ' + (junk.length - 12) + ' 条');
  if (APPLY) {
    const r = prune();
    console.log('  已删除 ' + r.removed + ' 条，保留 ' + r.kept + ' 条');
  } else {
    console.log('  （只预览；加 --apply 才真删）');
  }
}
