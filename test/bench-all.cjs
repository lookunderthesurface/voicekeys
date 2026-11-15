// 逐条测：起进程到就绪、go 到执行完成
//   node test/bench-all.cjs
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const PHRASES = ['声音大一点', '声音小一点', '静音', '发送', '暂停爱奇艺', '播放爱奇艺'];

function runOne(phrase, gateMs = 1000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CLI, 'pending', phrase], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let buf = '';
    let readyAt = 0;
    let exited = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (!readyAt && buf.includes('"ready":true')) {
        readyAt = Date.now();
        setTimeout(() => { try { child.stdin.write('go\n'); } catch { /* gone */ } }, Math.max(0, gateMs - (Date.now() - t0)));
      }
    });

    child.on('exit', () => {
      if (exited) return;
      exited = true;
      const lines = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const final = lines.find((r) => r.ok !== undefined && r.execution);
      resolve({
        ready: readyAt ? readyAt - t0 : -1,
        exec: final && final.execution ? final.execution.elapsedMs : -1,
        total: Date.now() - t0,
        note: final && final.execution && final.execution.results[0] ? final.execution.results[0].note || '' : '',
      });
    });
  });
}

(async () => {
  console.log('  词组           起→就绪   go→完成   含1秒静音的总延迟');
  for (const p of PHRASES) {
    const r = await runOne(p, 1000);
    console.log(`  ${p.padEnd(10)}  ${String(r.ready).padStart(5)}ms  ${String(r.exec).padStart(7)}ms  ${String(1000 + r.exec).padStart(6)}ms   ${r.note}`);
    await new Promise((res) => setTimeout(res, 1200));
  }
})();
