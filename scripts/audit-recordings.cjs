// 录音素材审计：WAV 格式分布 + index.jsonl 的触发来源统计
const fs = require('node:fs');
const path = require('node:path');

const data = path.join(process.env.LOCALAPPDATA, 'VoiceKeys');
const dirs = {
  capture: path.join(data, 'capture'),
  'capture-legacy-4s': path.join(data, 'capture-legacy-4s'),
  calib: path.join(data, 'calib'),
};

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, why: 'not RIFF/WAVE' };
  let p = 12, fmt = null, dataLen = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(p + 8),
        channels: b.readUInt16LE(p + 10),
        rate: b.readUInt32LE(p + 12),
        bits: b.readUInt16LE(p + 22),
      };
    } else if (id === 'data') { dataLen = size; }
    p += 8 + size + (size % 2);
  }
  if (!fmt) return { ok: false, why: 'no fmt' };
  const bytesPerSample = (fmt.bits / 8) * fmt.channels;
  const frames = dataLen / bytesPerSample;
  return { ok: true, ...fmt, dataLen, sec: frames / fmt.rate };
}

const out = {};
for (const [name, dir] of Object.entries(dirs)) {
  if (!fs.existsSync(dir)) { out[name] = { missing: true }; continue; }
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.wav')) files.push(p);
    }
  })(dir);
  const groups = new Map();
  for (const f of files) {
    const h = readWav(f);
    const key = h.ok ? `${h.rate}Hz/${h.channels}ch/${h.bits}bit/${h.format}` : `BAD:${h.why}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ f, sec: h.ok ? h.sec : 0, size: fs.statSync(f).size });
  }
  out[name] = { total: files.length, groups: [...groups.entries()].map(([k, arr]) => ({ fmt: k, n: arr.length, sample: path.basename(arr[0].f), durMin: Math.min(...arr.map((x) => x.sec)), durMax: Math.max(...arr.map((x) => x.sec)) })) };
}
console.log(JSON.stringify(out, null, 2));

// index.jsonl 统计
const idx = path.join(data, 'capture', 'index.jsonl');
if (fs.existsSync(idx)) {
  const rows = fs.readFileSync(idx, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log('\n=== index.jsonl ===');
  console.log('entries:', rows.length);
  console.log('keys:', [...new Set(rows.flatMap((r) => Object.keys(r)))].join(', '));
  console.log('sample:', JSON.stringify(rows[rows.length - 1]));
  const counts = {};
  for (const r of rows) {
    const k = String(r.kind ?? r.type ?? r.reason ?? 'unknown');
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log('kind/type 分布:', JSON.stringify(counts));
}
