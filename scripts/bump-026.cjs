// 版本 0.2.5 → 0.2.6（package.json / build-setup.ps1 / setup.cs）
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

const edits = [
  [path.join(ROOT, 'package.json'), [['"version": "0.2.5"', '"version": "0.2.6"']]],
  [path.join(ROOT, 'packaging', 'build-setup.ps1'), [
    ["param([string]$Version = '0.2.5')", "param([string]$Version = '0.2.6')"],
    ['[-Version 0.2.5]', '[-Version 0.2.6]'],
  ]],
  [path.join(ROOT, 'packaging', 'setup.cs'), [['"DisplayVersion", "0.2.5"', '"DisplayVersion", "0.2.6"']]],
];

for (const [f, pairs] of edits) {
  let s = fs.readFileSync(f, 'utf8');
  let n = 0;
  for (const [a, b] of pairs) if (s.includes(a)) { s = s.split(a).join(b); n += 1; }
  fs.writeFileSync(f, s, 'utf8');
  console.log('  ' + path.basename(f) + ': ' + n + ' 处');
}
