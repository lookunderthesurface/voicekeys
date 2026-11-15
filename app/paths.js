// 路径解析：应用自带依赖优先，其次才是开发布局
//
// 2026-11-16 变更：运行时依赖已经复制进 `lib/`（audio/handy + sherpa + pvrecorder），
// 所以 VoiceKeys 不再需要旁边的 DSH 插件目录。解析顺序：
//   1. VOICEKEYS_VENDOR（安装包自定义）
//   2. app 目录下的 lib/（随程序发布）
//   3. 开发布局 tools/voice-plugin（仅本机开发时兜底）
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');

function candidates() {
  const list = [];
  if (process.env.VOICEKEYS_VENDOR) list.push(process.env.VOICEKEYS_VENDOR);
  list.push(path.join(APP_ROOT, 'lib'));
  list.push(path.resolve(APP_ROOT, '..', 'voice-plugin'));
  return list;
}

function resolveRoot(need) {
  for (const root of candidates()) {
    try { if (need(root)) return root; } catch { /* next */ }
  }
  return null;
}

/** 音频/录制/Handy 所在的运行时根 */
function pluginRoot() {
  return resolveRoot((root) => fs.existsSync(path.join(root, 'runtime', 'listener', 'audio.cjs')));
}

/** 某个 npm 包目录 */
function packageDir(name) {
  return resolveRoot((root) => fs.existsSync(path.join(root, 'node_modules', name)));
}


/** 按名字加载随包依赖：lib/node_modules 不在 Node 的默认搜索路径上，必须显式指过去 */
function requirePackage(name) {
  for (const root of candidates()) {
    const dir = path.join(root, 'node_modules', name);
    if (fs.existsSync(dir)) return require(dir);
  }
  throw new Error('缺少依赖 ' + name + '：先在仓库根目录运行 npm install --prefix lib');
}

module.exports = { APP_ROOT, candidates, pluginRoot, packageDir, requirePackage };
