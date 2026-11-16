// A/B 对比：用**真实录音素材**比较"旧裁决逻辑"和"新裁决逻辑"
//
// 数据来源：capture/index.jsonl 里每条真触发过的记录
//   - ourText  = 当时 M1 提出的候选词（也就是用户当时说的词）
//   - bestScore= 当时 M1 的分数
//   - m2Text   = 当时 M2 对着真实音频的转写
// 判定只依赖 (候选词, M1 分数, M2 转写)，所以可以在这份真实数据上忠实重放两种逻辑。
//
// 正确 = 执行候选词（fire candidate）；错误 = 丢弃（漏）或改判成别的词（危险）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const policy = require(path.join(ROOT, 'app', 'pipeline', 'policy.js'));

const CAP = config.DIRS.capture;
const rows = fs.readFileSync(path.join(CAP, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: p.say }));
const live = new Set(words.map((w) => w.word));
const usable = rows.filter((r) => live.has(r.ourText) && r.m2Text && String(r.m2Text).trim());
const TH = 0.7;
const P = policy.DEFAULT_POLICY;

// ---------- 旧逻辑（本次改动前：先看候选词自己，不够再看别的词，差 0.1 才改判）
function oldVerdict(cand, m1Score, m2Text) {
  const own = matcher.findWord(m2Text, [{ word: cand, planKey: cand }], 0);
  const ownScore = own ? own.score : 0;
  const best = matcher.findWord(m2Text, words, TH);
  if (ownScore >= TH) return { action: 'fire', word: cand, why: 'M2 认同候选词' };
  if (best && best.word !== cand && best.score >= TH && best.score > ownScore + 0.1) {
    return { action: 'swap', word: best.word, why: 'M2 改判' };
  }
  return { action: 'drop', why: 'M2 否决' };
}

// ---------- 新逻辑（policy 里的纯函数，运行时用的就是它）
function newVerdict(cand, m1Score, m2Text) {
  const scored = matcher.scoreAll(m2Text, words);
  return policy.verdictFromScores({
    candidate: cand,
    m1Score,
    scored,
    thresholdOf: () => TH,
    policy: P,
  });
}
const tally = (name, fn) => {
  const out = { fire: [], drop: [], swap: [] };
  for (const r of usable) {
    const v = fn(r.ourText, Number(r.bestScore) || 0, r.m2Text);
    if (v.action === 'fire' && v.word === r.ourText) out.fire.push({ r, v });
    else if (v.action === 'swap') out.swap.push({ r, v });
    else out.drop.push({ r, v });
  }
  console.log('');
  console.log('  ' + name + '（共 ' + usable.length + ' 条真实素材）');
  console.log('    ✔ 正确执行候选词: ' + out.fire.length + '  (' + Math.round((out.fire.length / usable.length) * 100) + '%)');
  console.log('    ✘ 漏掉:          ' + out.drop.length);
  console.log('    ✘ 改判成别的词:  ' + out.swap.length);
  return out;
};

console.log('  素材：' + rows.length + ' 条；可用于判定对比：' + usable.length + ' 条（有 M2 转写且词还在词表里）');
for (const r of usable.slice(0, 3)) {
  console.log('    样例 ' + r.file + '  候选「' + r.ourText + '」 M1=' + Number(r.bestScore).toFixed(2) + '  M2「' + r.m2Text + '」');
}

const oldOut = tally('旧逻辑', oldVerdict);
const newOut = tally('新逻辑（你的方案）', newVerdict);

// 逐条对比：新逻辑改善/退步的
console.log('');
console.log('  逐条变化:');
let better = 0; let worse = 0;
for (const r of usable) {
  const a = oldVerdict(r.ourText, Number(r.bestScore) || 0, r.m2Text);
  const b = newVerdict(r.ourText, Number(r.bestScore) || 0, r.m2Text);
  const okA = a.action === 'fire' && a.word === r.ourText;
  const okB = b.action === 'fire' && b.word === r.ourText;
  if (!okA && okB) { better += 1; console.log('    ✅ 改善 ' + r.file + ' 候选「' + r.ourText + '」 M2「' + r.m2Text + '」 旧=' + a.action + ' 新=fire(' + b.why + ')'); }
  else if (okA && !okB) { worse += 1; console.log('    ⚠️ 退步 ' + r.file + ' 候选「' + r.ourText + '」 旧=fire 新=' + b.action + '(' + b.why + ')'); }
}
console.log('');
console.log('  合计：改善 ' + better + ' 条，退步 ' + worse + ' 条');
