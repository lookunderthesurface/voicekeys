// 开机自启：HKCU\Software\Microsoft\Windows\CurrentVersion\Run
// 为什么手写 reg 调用而不是引第三方模块：安装器/启动器都走系统自带工具，零依赖。
//
// 规则：
//   - 值名固定 VoiceKeys；数据 = "<安装目录>\VoiceKeys.exe" --no-browser
//     （带 --no-browser：开机时静默起在后台，不要弹浏览器）
//   - 只有 GUI 里的开关会改它；卸载器负责删除
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'VoiceKeys';

function launcherPath() {
  // app/ 的上一级就是安装目录
  return path.join(path.resolve(__dirname, '..'), 'VoiceKeys.exe');
}

function runReg(args) {
  return spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
}

function isEnabled() {
  try {
    const r = runReg(['query', RUN_KEY, '/v', VALUE_NAME]);
    return r.status === 0;
  } catch {
    return false;
  }
}

function setEnabled(on) {
  try {
    if (on) {
      const cmd = '"' + launcherPath() + '" --no-browser';
      const r = runReg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', cmd, '/f']);
      return { ok: r.status === 0, enabled: isEnabled(), command: cmd, error: r.status === 0 ? '' : (r.stderr || '').trim() };
    }
    const r = runReg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
    // 删除不存在的值会返回非 0，这时以实际状态为准
    return { ok: true, enabled: isEnabled(), error: r.status === 0 ? '' : (r.stderr || '').trim() };
  } catch (e) {
    return { ok: false, enabled: isEnabled(), error: e.message };
  }
}

module.exports = { isEnabled, setEnabled, launcherPath, VALUE_NAME, RUN_KEY };
