// 通过 HTTP 测 Planner：生成计划 → 绑定 → 再查状态
const http = require('node:http');

function post(path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port: 19600, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ error: data.slice(0, 200) }); }
        });
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(180000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 19600, path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

(async () => {
  console.log('  1) 生成计划：把音量调到七十');
  const gen = await post('/api/plan', { text: '把音量调到七十' });
  console.log('     ok=' + gen.ok + '  steps=' + JSON.stringify(gen.plan && gen.plan.steps) + '  model=' + gen.model + '  ' + gen.ms + 'ms');
  if (!gen.ok) { console.log('     错误: ' + JSON.stringify(gen.errors)); return; }

  console.log('  2) 绑定到「音量七十」');
  const bind = await post('/api/bind', { phrase: '音量七十', plan: gen.plan });
  console.log('     ok=' + bind.ok);

  console.log('  3) 状态里的词表');
  const s = await get('/api/state');
  console.log('     词数=' + s.words.length + '  新增=' + s.words.filter((w) => w.word === '音量七十').map((w) => w.word + '@' + w.threshold).join(','));

  console.log('  4) 直接执行这条计划（不发语音）');
  const run = await post('/api/run', { phrase: '音量七十' });
  console.log('     ok=' + run.ok + '  ' + JSON.stringify((run.execution && run.execution.results) || []));
})();
