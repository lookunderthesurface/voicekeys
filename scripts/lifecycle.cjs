// 可靠的启停工具：靠 PID 文件 + 端口，不靠命令行猜。
//
// 起因：主进程是用相对路径 `node app/server.js` 启动的，命令行里没有项目名，
// 之前用 “命令行匹配 voicekeys” 去杀进程时漏掉了主进程，只剩 ASR 子进程被杀，
// 结果出现“表面上重启了、其实跑的还是旧代码”的假象。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const DATA = require('../app/config.js').DIRS.root;
const PID_FILE = path.join(DATA, 'app.pid');
const PORT = Number(process.env.VK_PORT || 19600);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portOwner(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e && e.code === 'EADDRINUSE' ? 'in-use' : null));
    srv.once('listening', () => srv.close(() => resolve(null)));
    srv.listen(port, '127.0.0.1');
  });
}

function httpPid() {
  return new Promise((resolve) => {
    const req = require('node:http').request({ host: '127.0.0.1', port: PORT, path: '/api/pid', method: 'GET', timeout: 2000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d).pid || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function status() {
  let pid = null;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { /* none */ }
  const alive = pid ? isAlive(pid) : false;
  const port = await portOwner(PORT);
  const livePid = await httpPid();
  return { pid, alive, livePid, pidFileStale: Boolean(livePid && pid !== livePid), pidFile: PID_FILE, port, portBusy: port === 'in-use' };
}

async function stop() {
  let pid = null;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { /* none */ }
  if (!pid || !isAlive(pid)) {
    const livePid = await httpPid();      // PID 文件过期时，直接问正在跑的那个进程
    if (livePid && isAlive(livePid)) {
      try { process.kill(livePid, 'SIGTERM'); } catch { /* ignore */ }
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      return { stopped: true, pid: livePid, via: 'http' };
    }
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { stopped: false, reason: '没有活着的实例（PID 文件不存在或进程已退出）' };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  return { stopped: true, pid };
}

module.exports = { status, stop, PID_FILE, DATA };

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  (async () => {
    if (cmd === 'stop') {
      const r = await stop();
      console.log(JSON.stringify(r));
    } else {
      console.log(JSON.stringify(await status()));
    }
  })();
}
