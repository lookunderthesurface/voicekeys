// 老师的对外接口：把转写任务交给子进程（app/teacher-worker.js），本进程不加载模型。
//
// 之前是把 811MB 的模型直接加载进主进程，风险有两个：
//   · 模型加载失败 / 显存不足会把整个语音服务带崩
//   · 模型一直驻留，占用不释放
// 现在：每个校准任务起一个短命子进程，跑完自然退出，模型随之卸载。
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function findModel() {
  const cands = [
    process.env.VK_TEACHER_MODEL,
    path.join(process.env.USERPROFILE || '', '.cache', 'huggingface', 'hub',
      'models--handy-computer--Qwen3-ASR-0.6B-gguf', 'snapshots',
      'e4e16599b900eb0cb36e524514756bb92eb092b7', 'Qwen3-ASR-0.6B-Q8_0.gguf'),
  ].filter(Boolean);
  for (const p of cands) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 100 * 1024 * 1024) return p; } catch { /* ignore */ }
  }
  const hub = path.join(process.env.USERPROFILE || '', '.cache', 'huggingface', 'hub');
  try {
    for (const d of fs.readdirSync(hub)) {
      if (!d.includes('Qwen3-ASR')) continue;
      const snaps = path.join(hub, d, 'snapshots');
      for (const s of fs.readdirSync(snaps)) {
        for (const f of fs.readdirSync(path.join(snaps, s))) {
          if (f.endsWith('.gguf')) return path.join(snaps, s, f);
        }
      }
    }
  } catch { /* ignore */ }
  return '';
}

function modelInfo() {
  const p = findModel();
  let sizeMB = 0;
  try { sizeMB = p ? Math.round(fs.statSync(p).size / 1048576) : 0; } catch { /* ignore */ }
  return { path: p, found: Boolean(p), sizeMB };
}

/**
 * 转写一批文件。子进程会把进度按行吐回来。
 * @param {string[]} files
 * @param {(done:number,total:number,text:string)=>void} onProgress
 * @returns {Promise<{ok:boolean, results?:object, error?:string, loadMs?:number, ms?:number, modelPath?:string}>}
 */
function transcribeMany(files, onProgress = () => {}) {
  return new Promise((resolve) => {
    const info = modelInfo();
    if (!info.found) {
      resolve({ ok: false, error: '找不到老师的模型文件（Qwen3-ASR-0.6B GGUF）' });
      return;
    }

    // 任务写进临时文件再传给子进程（不用 stdin：会和 FFI 线程卡死）
    const jobFile = path.join(require('node:os').tmpdir(), `vk-teacher-job-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(jobFile, JSON.stringify({ files }));
    } catch (e) {
      resolve({ ok: false, error: '写任务文件失败: ' + e.message });
      return;
    }

    const child = spawn(process.execPath, [path.join(__dirname, 'teacher-worker.js'), jobFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buf = '';
    let done = null;
    let ready = null;
    let errMsg = '';
    let settled = false;

    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);   // 不清掉这个定时器，调用方的进程会一直挂到 5 分钟后
      resolve(payload);
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'ready') ready = msg;
        else if (msg.type === 'progress') onProgress(msg.done, msg.total, msg.text);
        else if (msg.type === 'done') done = msg;
        else if (msg.type === 'error') errMsg = msg.message;
      }
    });
    child.stderr.on('data', (c) => {
      const s = String(c).trim();
      if (s && !errMsg) errMsg = s.split('\n')[0].slice(0, 200);
    });
    child.on('error', (e) => finish({ ok: false, error: '启动老师子进程失败: ' + e.message }));
    child.on('exit', () => {
      if (done) {
        finish({ ok: true, results: done.results, ms: done.ms, loadMs: ready ? ready.loadMs : null, modelPath: info.path });
      } else {
        finish({ ok: false, error: errMsg || '老师子进程异常退出' });
      }
    });

    // 子进程 5 分钟还没跑完就杀掉（100 段正常只要十几秒）
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, error: '老师转写超时（>5 分钟）' });
    }, 5 * 60 * 1000);

    child.on('exit', () => {
      try { fs.unlinkSync(jobFile); } catch { /* ignore */ }
    });
  });
}

module.exports = { transcribeMany, modelInfo };
