// A/B：旧逻辑 vs 新逻辑（真实素材）
//
// 素材全部是"执行过"的记录，结局分三种：
//   ① 执行了 M1 提的那个词（正确）
//   ② 执行了别的词（M2 改判 → 错动作）
//   ③ 没执行（丢弃）
// 之前的统计把"改判"混进了"没识别"，所以看着像漏了很多。
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

function oldVerdict(cand, m1Score, m2Text) {
  const own = matcher.findWord(m2Text, [{ word: cand, planKey: cand }], 0);
  const ownScore = own ? own.score : 0;
  const best = matcher.findWord(m2Text, words, TH);
  if (ownScore >= TH) return { action: 'fire', word: cand };
  if (best && best.word !== cand && best.score >= TH && best.score > ownScore + 0.1) {
    return { action: 'swap', word: best.word };
  }
  return { action: 'drop' };
}

function newVerdict(cand, m1Score, m2Text) {
  return policy.verdictFromScores({
    candidate: cand,
    m1Score,
    scored: matcher.scoreAll(m2Text, words),
    thresholdOf: () => TH,
    policy: P,
  });
}

function tally(name, fn) {
  const out = { correct: 0, wrong: 0, drop: 0, samples: [] };
  for (const r of usable) {
    const v = fn(r.ourText, Number(r.bestScore) || 0, r.m2Text);
    if (v.action === 'fire' && v.word === r.ourText) out.correct += 1;
    else if (v.action === 'swap' || (v.action === 'fire' && v.word !== r.ourText)) {
      out.wrong += 1;
      if (out.samples.length < 5) out.samples.push(r.file + ' 候选「' + r.ourText + '」→ 执行「' + v.word + '」  M2「' + r.m2Text + '」');
    } else out.drop += 1;
  }
  console.log('');
  console.log('  ' + name + '（' + usable.length + ' 条真实素材）');
  console.log('    ✔ 执行对的词: ' + out.correct);
  console.log('    ✘ 执行错的词: ' + out.wrong);
  console.log('    ✘ 没执行:     ' + out.drop);
  if (out.samples.length) {
    console.log('    错动作样例:');
    for (const s of out.samples) console.log('      ' + s);
  }
  return out;
}

const m2decides = usable.filter((r) => r.verdict === 'm2-decides').length;
console.log('  素材 ' + rows.length + ' 条（全部是执行过的记录）；有 M2 转写可对比: ' + usable.length);
console.log('  其中 ' + m2decides + ' 条当时执行的是"别的词"（M2 改判）');

const a = tally('旧逻辑', oldVerdict);
const b = tally('新逻辑（你的方案）', newVerdict);

console.log('');
console.log('  变化：正确 ' + a.correct + ' → ' + b.correct + '，错动作 ' + a.wrong + ' → ' + b.wrong + '，未执行 ' + a.drop + ' → ' + b.drop);
