// 用 node 的 fetch 绑定中文词（PowerShell 5.1 的 Invoke-RestMethod 发中文 JSON 会被转码坏掉）
const BASE = 'http://127.0.0.1:19600';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

(async () => {
  const binds = [
    ['输入框', { steps: [{ op: 'dsh.focus' }] }],
    ['光标', { steps: [{ op: 'dsh.focus' }] }],
    ['写消息', { steps: [{ op: 'dsh.focus' }, { op: 'handy.set', target: 'on' }] }],
  ];
  for (const [phrase, plan] of binds) {
    const out = await post('/api/bind', { phrase, plan, model: 'manual' });
    console.log('bind ' + phrase + ' -> ok=' + out.ok + (out.entry ? '  steps=' + out.plan.steps.length : '  ' + JSON.stringify(out)));
  }
  const rm = await post('/api/unbind', { phrase: 'hello-test' });
  console.log('unbind hello-test -> ' + JSON.stringify(rm));

  const state = await (await fetch(BASE + '/api/state')).json();
  console.log('words=' + state.words.length);
  for (const w of state.words) {
    if (['输入框', '光标', '写消息', '发送'].includes(w.word)) console.log('  ' + w.word + '  kind=' + w.kind + '  planKey=' + String(w.planKey).slice(0, 80));
  }
})();
