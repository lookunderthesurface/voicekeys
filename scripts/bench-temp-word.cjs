// 临时往词表里加/删一个 benchmark 关键词（用完必须删）
//   node scripts/bench-temp-word.cjs add 你好米雅
//   node scripts/bench-temp-word.cjs restore
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(process.env.LOCALAPPDATA || '', 'VoiceKeys');
const PLANS = path.join(DATA, 'plans.json');
const BAK = path.join(DATA, 'plans.json.bench-bak');

const action = process.argv[2];

if (action === 'add') {
  const word = process.argv[3];
  if (!word) { console.log('用法: bench-temp-word.cjs add <词>'); process.exit(1); }
  if (!fs.existsSync(BAK)) fs.copyFileSync(PLANS, BAK);
  const plans = JSON.parse(fs.readFileSync(PLANS, 'utf8'));
  plans[word] = {
    say: word,
    plan: { steps: [] },
    model: 'bench-temp',
    boundAt: new Date().toISOString(),
    pauseMs: 600,
    kind: 'primary',
    aliasOf: '',
  };
  fs.writeFileSync(PLANS, JSON.stringify(plans, null, 2), 'utf8');
  console.log('  已临时加入「' + word + '」，现在词表 ' + Object.keys(plans).length + ' 个（备份在 ' + path.basename(BAK) + '）');
} else if (action === 'restore') {
  if (!fs.existsSync(BAK)) { console.log('  ✘ 没有备份文件，无法恢复'); process.exit(1); }
  const bak = fs.readFileSync(BAK, 'utf8');
  fs.writeFileSync(PLANS, bak, 'utf8');
  const plans = JSON.parse(fs.readFileSync(PLANS, 'utf8'));
  console.log('  已恢复原词表：' + Object.keys(plans).length + ' 个词');
  fs.unlinkSync(BAK);
  console.log('  备份已删除');
} else {
  console.log('用法: add <词> | restore');
}
