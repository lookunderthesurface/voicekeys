// 只保留"真的触发过"的素材，删掉 M2 否决/被取消的那些
//
// 用户 2026-11-16 的判断：5 秒窗口的价值是"把触发前那次失败也录进来"，
// 所以素材只该在触发时产生；没触发的录音没有校准价值，白占 500 个名额。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAP = require(path.join(ROOT, 'app', 'config.js')).DIRS.capture;
const indexFile = path.join(CAP, 'index.jsonl');

const FIRE_VERDICTS = new Set(['fast-path', 'agree', 'm2-decides']);

if (!fs.existsSync(indexFile)) { console.log('  没有 index.jsonl'); process.exit(0); }

const raw = fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean);
let keep = [];
let removed = 0;
let removedBytes = 0;
const reasons = {};

for (const line of raw) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (FIRE_VERDICTS.has(row.verdict)) { keep.push(row); continue; }
  const key = row.verdict || '(空)';
  reasons[key] = (reasons[key] || 0) + 1;
  const f = path.join(CAP, row.file);
  try {
    if (fs.existsSync(f)) { removedBytes += fs.statSync(f).size; fs.unlinkSync(f); }
    removed += 1;
  } catch { /* ignore */ }
}

fs.writeFileSync(indexFile, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8');

// 顺便清掉 index 里没有引用的孤儿 wav
const referenced = new Set(keep.map((r) => r.file));
let orphans = 0;
let orphanBytes = 0;
for (const f of fs.readdirSync(CAP)) {
  if (!f.endsWith('.wav')) continue;
  if (referenced.has(f)) continue;
  const p = path.join(CAP, f);
  orphanBytes += fs.statSync(p).size;
  fs.unlinkSync(p);
  orphans += 1;
}

console.log('  保留（触发过）: ' + keep.length + ' 条');
console.log('  删除（没触发）: ' + removed + ' 条，' + Math.round(removedBytes / 1048576 * 10) / 10 + ' MB');
console.log('  删除（孤儿文件）: ' + orphans + ' 个，' + Math.round(orphanBytes / 1048576 * 10) / 10 + ' MB');
console.log('  按原因: ' + JSON.stringify(reasons));
