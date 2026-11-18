// 把开发目录的最新代码同步进已安装的 VoiceKeys（不重新打包、不重新下载）
const fs = require('node:fs');
const path = require('node:path');

const DEV = path.resolve(__dirname, '..');
const INSTALL = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'VoiceKeys');

if (!fs.existsSync(path.join(INSTALL, 'app', 'server.js'))) {
  console.error('  ✘ 找不到已安装的 VoiceKeys: ' + INSTALL);
  process.exit(1);
}

const DIRS = ['app', 'src', 'scripts', 'examples', 'docs', 'test'];
const FILES = ['README.md', 'LICENSE', 'NOTICE', 'package.json'];
const LIB_LISTENER = ['audio.cjs', 'config.cjs', 'protocol.cjs', 'handy.cjs'];

function copyDir(from, to, skip = []) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    if (skip.includes(f)) continue;
    const s = path.join(from, f);
    const d = path.join(to, f);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

// runtime 只同步 worker.ps1（node.exe/其它运行时文件不覆盖）
{
  const srcWorker = path.join(DEV, 'runtime', 'worker.ps1');
  const dstWorker = path.join(INSTALL, 'runtime', 'worker.ps1');
  if (fs.existsSync(srcWorker) && fs.existsSync(path.dirname(dstWorker))) {
    fs.copyFileSync(srcWorker, dstWorker);
    console.log('  worker.ps1 已同步');
  }
}
for (const d of DIRS) {
  const from = path.join(DEV, d);
  if (!fs.existsSync(from)) continue;
  // app/algorithms 单独处理（保留 user/ 与 .backup/）
  copyDir(from, path.join(INSTALL, d), d === 'app' ? ['algorithms'] : []);
}

// 算法默认实现（保留 user/）
const algoDev = path.join(DEV, 'app', 'algorithms');
const algoInst = path.join(INSTALL, 'app', 'algorithms');
fs.mkdirSync(algoInst, { recursive: true });
for (const f of fs.readdirSync(algoDev)) {
  const s = path.join(algoDev, f);
  if (fs.statSync(s).isDirectory()) continue;
  fs.copyFileSync(s, path.join(algoInst, f));
}

for (const f of FILES) {
  const s = path.join(DEV, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(INSTALL, f));
}

const listenerDev = path.join(DEV, 'lib', 'runtime', 'listener');
const listenerInst = path.join(INSTALL, 'lib', 'runtime', 'listener');
for (const f of LIB_LISTENER) {
  const s = path.join(listenerDev, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(listenerInst, f));
}

console.log('  ✔ 已同步代码到 ' + INSTALL);
console.log('    保留未动：runtime\\node.exe、lib\\node_modules、uninstall.exe');
