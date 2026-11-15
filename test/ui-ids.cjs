// 静态检查：ui.html 里的 DOM id 与 JS 中 $('id') 的引用是否一致。
// 这类错误在浏览器里只会静默报 null（点了没反应），很容易漏掉。
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'app', 'ui.html');
const html = fs.readFileSync(file, 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

// 运行时才拼出来的 id 不算缺失
const dynamic = new Set([
  'npUtter', 'npGen', 'npPreview', 'npWord', 'npChips', 'npSave', 'npCancel', 'npManual', 'npJson', 'npUseJson',
  'setOllamaUrl', 'setOllamaModel', 'setOpenaiUrl', 'setOpenaiKey', 'setOpenaiModel', 'setDeepseekKey', 'setDeepseekModel',
  'btnOllamaCheck',
]);

const missing = [...used].filter((u) => !ids.has(u) && !dynamic.has(u));
const unused = [...ids].filter((i) => !used.has(i));

console.log('  HTML 定义 id: ' + ids.size);
console.log('  JS 引用 id: ' + used.size);
console.log('  HTML 有但 JS 没直接用: ' + (unused.length ? unused.join(', ') : '无'));

if (missing.length) {
  console.log('  \u2718 真正缺失的 id: ' + missing.join(', '));
  process.exit(1);
}
console.log('  \u2714 没有缺失的 id');
