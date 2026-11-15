// 一键还原「所有可编辑的脚本」到最近一次备份
//
// 为什么这样设计（用户 2026-11-16 要求）：
//   只有两条命令——备份全部、还原全部。不做"只还原某一个"，
//   因为用户改的时候往往是几个脚本一起改（比如匹配算法 + 静音门），
//   逐个挑容易漏，回到一个完整快照最稳。
//
// 用法：
//   node scripts/restore-algorithms.cjs        # 还原到最近一次备份
//   node scripts/restore-algorithms.cjs --dry  # 只看会动什么
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USER_DIR = path.join(require('../app/config.js').DIRS.algorithms, 'user');
const SETTINGS = path.join(ROOT, 'app', 'settings.json');
const FALLBACK_SETTINGS = path.join(ROOT, 'src', 'settings.json');
const { LATEST } = require(path.join(__dirname, 'backup-algorithms.cjs'));

function settingsPath() {
  return fs.existsSync(SETTINGS) ? SETTINGS : FALLBACK_SETTINGS;
}

function main() {
  const dry = process.argv.includes('--dry');
  if (!fs.existsSync(LATEST)) {
    console.log('  ✘ 还没有任何备份。先跑: node scripts/backup-algorithms.cjs');
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
  const srcDir = meta.dir;
  if (!fs.existsSync(srcDir)) {
    console.log('  ✘ 备份目录不见了: ' + srcDir);
    process.exit(1);
  }

  // 1) 先把当前所有自定义文件删掉（回到"没有自定义"的干净状态）
  let removed = [];
  if (fs.existsSync(USER_DIR)) {
    for (const f of fs.readdirSync(USER_DIR)) {
      if (f === '.gitkeep') continue;
      removed.push(f);
      if (!dry) fs.unlinkSync(path.join(USER_DIR, f));
    }
  }

  // 2) 把快照里的文件拷回去
  const restored = [];
  for (const f of meta.files || []) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src)) continue;
    restored.push(f);
    if (!dry) fs.copyFileSync(src, path.join(USER_DIR, f));
  }

  // 3) 恢复 settings 里的 algorithms 指向
  const file = settingsPath();
  if (fs.existsSync(file)) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { cfg = {}; }
    cfg.algorithms = meta.algorithms || {};
    if (!dry) fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  }

  console.log('  备份点: ' + srcDir);
  console.log('  当前自定义文件（被清掉）: ' + (removed.length ? removed.join(', ') : '（无）') + (dry ? '  ← 预览' : ''));
  console.log('  从备份恢复: ' + (restored.length ? restored.join(', ') : '（无）') + (dry ? '  ← 预览' : ''));
  console.log('  settings.algorithms 恢复为: ' + JSON.stringify(meta.algorithms || {}) + (dry ? '  ← 预览' : ''));
  console.log(dry ? '  （加 --dry 之外不要参数才会真的动手）' : '  ✔ 已还原；重启应用后生效（界面上的「重启」按钮或 node scripts/lifecycle.cjs）');
}

main();
