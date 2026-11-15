// 找出所有"外部 npm 依赖"（裸模块名），确保 lib/package.json 里都有
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const builtin = new Set(require('node:module').builtinModules);
const found = new Map();

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f === '.backup' || f === 'user') continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(js|cjs)$/.test(f)) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const id = m[1];
      if (id.startsWith('.') || id.startsWith('/')) continue;
      if (id.startsWith('node:')) continue;
      const bare = id.split('/')[0].startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
      if (builtin.has(bare)) continue;
      if (!found.has(bare)) found.set(bare, new Set());
      found.get(bare).add(path.relative(ROOT, p));
    }
  }
}

walk(path.join(ROOT, 'app'));
walk(path.join(ROOT, 'src'));

console.log('  外部依赖:');
for (const [k, v] of [...found].sort()) {
  console.log('    ' + k.padEnd(24) + [...v].slice(0, 3).join(', '));
}
