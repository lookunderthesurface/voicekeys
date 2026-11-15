// 基准：预准备进程到底能省多少时间
//   node test/bench-pending.cjs "暂停爱奇艺"
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const phrase = process.argv[2] || '暂停爱奇艺';

function runPending(delayMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CLI, 'pending', phrase], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let out = '';
    let readyAt = 0;
    let done = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const lines = out.split('\n').filter(Boolean);
      const ready = lines.find((l) => l.includes('"ready":true'));
      if (ready && !readyAt) {
        readyAt = Date.now();
        // 模拟"1 秒静音确认"：等 delayMs 再发 go
        setTimeout(() => child.stdin.write('go\n'), Math.max(0, delayMs - (Date.now() - t0)));
      }
    });

    child.on('exit', () => {
      if (done) return;
      done = true;
      const result = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const final = result.find((r) => r.ok !== undefined);
      resolve({
        spawnToReady: readyAt ? readyAt - t0 : -1,
        goToDone: final && final.execution ? final.execution.elapsedMs : -1,
        warmupMs: final ? final.warmupMs : -1,
        total: Date.now() - t0,
        note: final && final.execution && final.execution.results[0] ? final.execution.results[0].note : '',
      });
    });
  });
}

(async () => {
  console.log('  词组: ' + phrase);
  for (const delay of [1000, 600]) {
    const r = await runPending(delay);
    console.log(`  延迟 ${delay}ms → 起进程到就绪 ${r.spawnToReady}ms，go 到完成 ${r.goToDone}ms，总计 ${r.total}ms`);
    if (r.note) console.log('    ' + r.note);
    await new Promise((res) => setTimeout(res, 1200));
  }
})();
