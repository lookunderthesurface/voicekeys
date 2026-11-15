// 跑一次校准：老师模型 → 算建议（加/删同义词、重复次数）→ 存 capture/suggestions.json
//
// 用法：node scripts/calibrate.cjs
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const teacher = require(path.join(ROOT, 'app', 'teacher.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { suggest } = require(path.join(ROOT, 'app', 'calibrator.js'));

const CAP = process.env.VK_CAPTURE_DIR || require('../app/config.js').DIRS.capture;
const OUT = path.join(CAP, 'suggestions.json');

(async () => {
  const indexFile = path.join(CAP, 'index.jsonl');
  if (!fs.existsSync(indexFile)) { console.log('  没有素材'); return; }
  const rows = fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const files = rows.map((r) => path.join(CAP, r.file)).filter((f) => fs.existsSync(f));
  console.log('  素材 ' + rows.length + ' 条，其中文件存在 ' + files.length + ' 条');

  console.log('  老师模型转写中…');
  const t0 = Date.now();
  const t = await teacher.transcribeMany(files, (done, total) => {
    if (done % 25 === 0 || done === total) process.stdout.write('    ' + done + '/' + total + '\n');
  });
  if (!t.ok) { console.log('  老师失败: ' + t.error); return; }
  console.log('  完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's（加载 ' + t.loadMs + 'ms）');

  const teacherByFile = new Map();
  for (const [name, text] of Object.entries(t.results || {})) {
    teacherByFile.set(path.basename(name), String(text || '').trim());
  }

  const words = planner.listVerbose();
  const report = suggest({ entries: rows, teacherByFile, words });
  const payload = {
    at: new Date().toISOString(),
    material: rows.length,
    words: words.map((w) => ({ say: w.say, kind: w.kind, aliasOf: w.aliasOf, thresholds: w.thresholds })),
    ...report,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');

  console.log('');
  console.log('  词表: 主词 ' + words.filter((w) => w.kind === 'primary').length + ' / 同义词 ' + words.filter((w) => w.kind === 'synonym').length);
  console.log('  统计: ' + JSON.stringify(report.stats));
  console.log('  建议【加】同义词 ' + report.addSynonyms.length + ' 条:');
  for (const a of report.addSynonyms.slice(0, 8)) {
    console.log('    ' + a.word + '  +  「' + a.variant + '」 ×' + a.count + '   (老师: ' + (a.samples[0] || {}).truth + ')');
  }
  console.log('  建议【删】同义词 ' + report.removeSynonyms.length + ' 条:');
  for (const a of report.removeSynonyms.slice(0, 8)) {
    console.log('    ' + a.word + ' ×' + a.count + '   (老师: ' + (a.samples[0] || {}).truth + ')');
  }
  console.log('  一段里出现多次（前面的都失败了） ' + report.repeats.length + ' 条:');
  for (const a of report.repeats.slice(0, 8)) {
    console.log('    ' + a.word + ' ×' + a.times + '   「' + a.truth + '」');
  }
  console.log('');
  console.log('  已保存: ' + OUT);
})();
