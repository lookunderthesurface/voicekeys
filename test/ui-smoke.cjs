// UI 冒烟测试：把页面里的 <script> 拿到最小 DOM 桩里跑一遍 render(真实 state)
//
// 为什么要这个：今天"词表全空、面板空白"的根因就是 renderPlans 调用了不存在的 thOf，
// 抛 ReferenceError 让整个 innerHTML 赋值中止。`new Function` 只查语法，查不出这种错。
// 这个脚本会把 /api/state 的真实数据喂给 render()，任何 ReferenceError 都会暴露。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'ui.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (!scripts.length) { console.log('  ✘ 页面里没有脚本'); process.exit(1); }
const code = scripts[0];

// ---- 最小 DOM 桩：只要能让 render 跑完并记录 innerHTML
const nodes = new Map();
function makeNode(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    className: '',
    style: {},
    checked: false,
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    focus() {},
    remove() {},
    getAttribute() { return null; },
    setAttribute() {},
  };
}
const documentStub = {
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  createElement(tag) { return makeNode(tag); },
  activeElement: null,
  body: makeNode('body'),
};
const windowStub = { addEventListener() {}, location: { href: '' }, setInterval() {}, setTimeout() {} };

// 取真实 state（服务没起时用本地构造的最小样本）
function getState() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:19600/api/state', (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  const state = await getState();
  if (!state) { console.log('  ⚠ 服务没起，用最小样本'); }
  const sample = state || {
    mode: 'listening', source: 'mic', device: 0, micCount: 1, peak2s: 0, words: [], plans: [],
    events: [], capture: { count: 0, max: 500, autoClean: true }, pipeline: { policy: { fastPathThreshold: 0.95 } },
    models: { ok: true }, handyRecording: false, pauseMs: 600,
  };

  const sandbox = {
    document: documentStub,
    window: windowStub,
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    console,
    setInterval() {}, setTimeout() {},
    CSS: { escape: (v) => String(v) },
    navigator: { clipboard: { writeText() {} } },
    alert() {}, confirm() { return false; }, prompt() { return null; },
    Date, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, Promise, RegExp, Error,
  };

  try {
    const fn = new Function(...Object.keys(sandbox), code + '\n;return { render, thOf, gateOf };');
    const api = fn(...Object.values(sandbox));
    api.render(sample);
    const list = nodes.get('planList');
    const count = nodes.get('planCount');
    console.log('  render 跑完');
    console.log('  planCount = ' + (count ? count.textContent : '(无)'));
    console.log('  planList 长度 = ' + (list ? list.innerHTML.length : 0));
    if (sample.plans && sample.plans.length && (!list || list.innerHTML.length < 50)) {
      console.log('  ✘ 有 ' + sample.plans.length + ' 个计划，但词表没渲染出来');
      process.exit(1);
    }
    console.log('  ✔ 词表渲染正常');
  } catch (e) {
    console.log('  ✘ render 抛错: ' + e.message);
    console.log('     ' + String(e.stack || '').split('\n')[1]);
    process.exit(1);
  }
})();
