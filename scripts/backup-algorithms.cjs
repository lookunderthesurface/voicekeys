// 一键备份「所有可编辑的脚本」
//
// 为什么要这个：用户会（让 AI 帮他）改匹配算法等可编辑脚本。改之前必须先留一份完整快照，
// 改坏了用 restore-algorithms.cjs 一条命令回到这个快照，不需要记得改了哪几个文件。
//
// 备份范围（"所有可编辑的脚本"）：
//   app/algorithms/user/*.js        用户自定义实现
//   app/settings.json 的 algorithms 段（指向哪个文件）
//
// 用法：
//   node scripts/backup-algorithms.cjs          # 备份一次（生成时间戳目录，并更新 latest 指针）
//   node scripts/backup-algorithms.cjs --list   # 看看有哪些快照
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USER_DIR = path.join(require('../app/config.js').DIRS.algorithms, 'user');
const BACKUP_ROOT = require('../app/config.js').DIRS.backups;
const LATEST = path.join(BACKUP_ROOT, 'latest.json');
const SETTINGS = path.join(ROOT, 'app', 'settings.json');
const FALLBACK_SETTINGS = path.join(ROOT, 'src', 'settings.json');

function settingsPath() {
  return fs.existsSync(SETTINGS) ? SETTINGS : FALLBACK_SETTINGS;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把"程序内置的默认实现"展开成可直接编辑的副本。
 * 为什么：安装包里的算法应该在 exe 内部，用户不点"开始编辑"就看不到散文件；
 * 点了之后才有 user/*.js 可改，快照也才有意义。
 */
function materialize() {
  const ROLES = ['matcher', 'sampler', 'gate'];
  fs.mkdirSync(USER_DIR, { recursive: true });
  const created = [];
  const algorithms = {};
  for (const role of ROLES) {
    const def = path.join(ROOT, 'app', 'algorithms', role + '.default.js');
    const dst = path.join(USER_DIR, role + '.js');
    if (fs.existsSync(def) && !fs.existsSync(dst)) {
      fs.copyFileSync(def, dst);
      created.push(role + '.js');
    }
    if (fs.existsSync(dst)) algorithms[role] = role + '.js';
  }
  // 让程序从副本读（这样用户改文件就能生效）
  const file = settingsPath();
  if (fs.existsSync(file) && Object.keys(algorithms).length) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { cfg = {}; }
    cfg.algorithms = Object.assign({}, cfg.algorithms || {}, algorithms);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  }
  return created;
}

function backup() {
  const created = materialize();
  if (created.length) console.log('  已展开可编辑副本: ' + created.join(', '));
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const dir = path.join(BACKUP_ROOT, stamp());
  fs.mkdirSync(dir, { recursive: true });

  const files = [];
  if (fs.existsSync(USER_DIR)) {
    for (const f of fs.readdirSync(USER_DIR)) {
      if (f === '.gitkeep') continue;
      fs.copyFileSync(path.join(USER_DIR, f), path.join(dir, f));
      files.push(f);
    }
  }

  // 记下 settings 里的 algorithms 指向（还原时要一起恢复）
  let algorithms = {};
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, '');
    algorithms = (JSON.parse(raw).algorithms) || {};
  } catch { algorithms = {}; }
  fs.writeFileSync(path.join(dir, 'algorithms.json'), JSON.stringify(algorithms, null, 2), 'utf8');

  const meta = { at: new Date().toISOString(), dir, files, algorithms };
  fs.writeFileSync(LATEST, JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function list() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs.readdirSync(BACKUP_ROOT).filter((d) => fs.statSync(path.join(BACKUP_ROOT, d)).isDirectory()).sort();
}

if (require.main === module) {
  if (process.argv.includes('--list')) {
    const all = list();
    console.log('  快照: ' + (all.length ? all.join(', ') : '（无）'));
    if (fs.existsSync(LATEST)) {
      const m = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
      console.log('  latest: ' + m.dir + '  文件 ' + (m.files.length ? m.files.join(', ') : '（无）'));
    }
  } else {
    const meta = backup();
    console.log('  ✔ 已备份 ' + meta.files.length + ' 个文件 → ' + meta.dir);
    console.log('    文件: ' + (meta.files.length ? meta.files.join(', ') : '（当前没有自定义文件，仍然记录了 settings 指向）'));
    console.log('    还原命令: node scripts/restore-algorithms.cjs');
  }
}

module.exports = { backup, list, BACKUP_ROOT, LATEST, USER_DIR };
