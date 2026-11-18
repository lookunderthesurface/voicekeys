// 把「开机自启开关」接进 server.js + ui.html（一次性补丁脚本，跑完即删）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ---------- server.js ----------
{
  const f = path.join(ROOT, 'app', 'server.js');
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes("require('./autostart.js')")) {
    s = s.replace(
      "const providers = require('./providers.js');",
      "const providers = require('./providers.js');\nconst autostart = require('./autostart.js');",
    );
  }
  if (!s.includes('autostart: autostart.isEnabled()')) {
    s = s.replace(
      "    if (p === '/api/settings' && req.method === 'GET') {\n      return json(res, 200, providers.publicView());\n    }",
      "    if (p === '/api/settings' && req.method === 'GET') {\n      return json(res, 200, { ...providers.publicView(), autostart: autostart.isEnabled() });\n    }",
    );
    s = s.replace(
      "      const body = JSON.parse((await readBody(req)) || '{}');\n      // 界面回传打码的 key 时不要覆盖真实 key",
      "      const body = JSON.parse((await readBody(req)) || '{}');\n      // 开机自启：不在 settings.json 里存，直接写/删 HKCU Run\n      let autostartResult = null;\n      if (Object.prototype.hasOwnProperty.call(body, 'autostart')) {\n        autostartResult = autostart.setEnabled(!!body.autostart);\n        delete body.autostart;\n      }\n      // 界面回传打码的 key 时不要覆盖真实 key",
    );
    s = s.replace(
      "      return json(res, 200, { ok: true, settings: providers.publicView() });",
      "      return json(res, 200, { ok: true, settings: providers.publicView(), autostart: autostart.isEnabled(), autostartResult });",
    );
  }
  fs.writeFileSync(f, s, 'utf8');
  const ok = s.includes("require('./autostart.js')") && s.includes('autostart: autostart.isEnabled()');
  console.log('  server.js 打补丁: ' + (ok ? 'OK' : '失败'));
}

// ---------- ui.html ----------
{
  const f = path.join(ROOT, 'app', 'ui.html');
  let s = fs.readFileSync(f, 'utf8');

  const panel = `    <section class="panel">
      <h2>运行方式</h2>
      <label style="cursor:pointer;display:flex;align-items:center;gap:8px;margin:6px 0 4px">
        <input type="checkbox" id="autoStartToggle"> <span>开机自启（登录 Windows 后自动在后台运行）</span>
      </label>
      <div class="hint">开启后在 <code>HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run</code> 登记一项，以 <code>--no-browser</code> 静默启动；关闭即删除。后台运行时右下角通知区有 VoiceKeys 托盘图标，双击打开控制台。</div>
    </section>

    <section class="panel">
      <h2>自校准（采集 → 老师复核）</h2>`;

  if (!s.includes('id="autoStartToggle"')) {
    s = s.replace('    <section class="panel">\n      <h2>自校准（采集 → 老师复核）</h2>', panel);
  }

  const js = `
// ---- 开机自启开关 ----
async function loadAutoStart() {
  try {
    const s = await api('/api/settings');
    const t = document.getElementById('autoStartToggle');
    if (t) t.checked = !!s.autostart;
  } catch { /* ignore */ }
}
document.addEventListener('change', async (ev) => {
  if (!ev.target || ev.target.id !== 'autoStartToggle') return;
  try {
    const r = await api('/api/settings', { autostart: ev.target.checked });
    ev.target.checked = !!r.autostart;
    if (r.autostartResult && r.autostartResult.ok === false) alert('写入失败：' + (r.autostartResult.error || '未知错误'));
  } catch (e) { alert('设置失败：' + e.message); loadAutoStart(); }
});
setTimeout(loadAutoStart, 900);
`;

  if (!s.includes('loadAutoStart')) {
    s = s.replace('setTimeout(loadCalib, 1200);', 'setTimeout(loadCalib, 1200);' + js);
  }
  fs.writeFileSync(f, s, 'utf8');
  const ok = s.includes('id="autoStartToggle"') && s.includes('loadAutoStart');
  console.log('  ui.html 打补丁: ' + (ok ? 'OK' : '失败'));
}

// ---------- build-setup.ps1: launcher 编译加 WinForms 引用 ----------
{
  const f = path.join(ROOT, 'packaging', 'build-setup.ps1');
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes('/r:System.Windows.Forms.dll')) {
    s = s.replace(
      "/win32manifest:$manifest (Join-Path $root 'packaging\\launcher.cs')",
      "/win32manifest:$manifest /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $root 'packaging\\launcher.cs')",
    );
    fs.writeFileSync(f, s, 'utf8');
  }
  console.log('  build-setup.ps1 引用 WinForms: ' + (s.includes('/r:System.Windows.Forms.dll') ? 'OK' : '失败'));
}
