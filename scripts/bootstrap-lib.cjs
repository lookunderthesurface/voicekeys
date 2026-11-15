// 准备运行时依赖（lib/node_modules）
//
// 两种来源，按顺序尝试：
//   1. 本机有 voice-plugin（开发机）：直接复制，快
//   2. 没有：用 npm 从公共 registry 装（lib/package.json 里写好了版本）
//
// 用法：node scripts/bootstrap-lib.cjs
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const NEEDS = ['sherpa-onnx-node', 'sherpa-onnx-win-x64', path.join('@picovoice', 'pvrecorder-node')];

function haveAll() {
  return NEEDS.every((p) => fs.existsSync(path.join(LIB, 'node_modules', p)));
}

function fromNpm() {
  console.log('  用 npm 安装依赖到 lib/ …');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', LIB, '--no-audit', '--no-fund'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
}

function fromPlugin(src) {
  console.log('  从 ' + src + ' 复制依赖…');
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      const s = path.join(from, f);
      const d = path.join(to, f);
      const st = fs.statSync(s);
      if (st.isDirectory()) copyDir(s, d);
      else if (!fs.existsSync(d) || fs.statSync(d).size !== st.size) fs.copyFileSync(s, d);
    }
  };
  for (const pkg of NEEDS) {
    const from = path.join(src, 'node_modules', pkg);
    if (fs.existsSync(from)) copyDir(from, path.join(LIB, 'node_modules', pkg));
  }
  // 纯 JS 的录音封装
  const listener = path.join(LIB, 'runtime', 'listener');
  fs.mkdirSync(listener, { recursive: true });
  for (const f of ['audio.cjs', 'config.cjs', 'protocol.cjs', 'handy.cjs']) {
    const from = path.join(src, 'runtime', 'listener', f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(listener, f));
  }
}

/** 音频封装是纯 JS，仓库里本来就有；这里只兜底 */
function ensureListener() {
  const listener = path.join(LIB, 'runtime', 'listener');
  const need = ['audio.cjs', 'config.cjs', 'protocol.cjs', 'handy.cjs'];
  const missing = need.filter((f) => !fs.existsSync(path.join(listener, f)));
  return missing;
}

const missing = ensureListener();
if (missing.length) {
  console.log('  ✘ lib/runtime/listener 缺文件: ' + missing.join(', '));
  console.log('    这些是纯 JS，应该随仓库提交；请检查仓库是否完整。');
  process.exit(1);
}

if (haveAll()) {
  console.log('  ✔ lib/node_modules 已就绪，无需安装');
  process.exit(0);
}

const plugin = process.env.VOICE_PLUGIN_DIR || path.resolve(ROOT, '..', 'voice-plugin');
if (fs.existsSync(path.join(plugin, 'node_modules', 'sherpa-onnx-node'))) {
  fromPlugin(plugin);
} else {
  fromNpm();
}

if (haveAll()) console.log('  ✔ 依赖就绪');
else { console.log('  ✘ 依赖仍不完整，请检查上面的 npm 输出'); process.exit(1); }
