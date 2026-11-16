// 用 0.6B 老师当答案，评估每条素材"当时到底该做什么动作 vs 现在逻辑会做什么"
//
// 关键修正（第一版评估的两个bug）：
//   ① fast-path 的记录没有 M2 转写（根本没叫 M2），不能拿 verdictFromScores 去判 → 按快速通道算
//   ② 动作要对齐到"计划"而不是词名：发送/发送消息/发送出去 是同一个计划（同义词），
//      执行哪个都一样。按词名比会虚报"判错"。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const policy = require(path.join(ROOT, 'app', 'pipeline', 'policy.js'));

const CAP = config.DIRS.capture;
const CACHE = path.join(ROOT, 'dist', 'teacher-cache.json');
const rows = fs.readFileSync(path.join(CAP, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const verbose = planner.listVerbose();
const words = verbose.map((p) => ({ word: p.say, planKey: p.say }));
const planOf = new Map();
const live = new Set();
for (const p of verbose) {
  live.add(p.say);
  planOf.set(p.say, JSON.stringify((p.plan && p.plan.steps) || []));
}
const usable = rows.filter((r) => live.has(r.ourText));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const TH = 0.7;
const P = policy.DEFAULT_POLICY;
const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
const samePlan = (a, b) => a && b && planOf.get(a) && planOf.get(a) === planOf.get(b);

function truthWord(text) {
  const t = norm(text);
  if (!t) return { word: null, times: 0 };
  const hits = words.filter((w) => t.includes(norm(w.word))).sort((a, b) => norm(b.word).length - norm(a.word).length);
  if (hits.length) {
    const w = hits[0].word;
    return { word: w, times: t.split(norm(w)).length - 1, how: 'literal' };
  }
  const all = matcher.scoreAll(t, words);
  const top = all[0];
  if (top && top.score >= TH) return { word: top.word, times: 1, how: 'fuzzy' };
  return { word: null, times: 0 };
}

/** 当前逻辑对这条记录会做什么（fast-path 记录按快速通道算） */
function currentAction(r) {
  if (r.verdict === 'fast-path') return { acted: r.ourText, rule: 'fast-path' };
  const scored = matcher.scoreAll(r.m2Text || '', words);
  const v = policy.verdictFromScores({
    candidate: r.ourText,
    m1Score: Number(r.bestScore) || 0,
    scored,
    thresholdOf: () => TH,
  });
  return { acted: (v.action === 'fire' || v.action === 'swap') ? v.word : null, rule: v.rule, scored };
}

const buckets = { ok: [], wrongWord: [], missed: [], falseFire: [], multi: [], noWord: [] };
for (const r of usable) {
  const truthText = cache[r.file] || '';
  const truth = truthWord(truthText);
  const cur = currentAction(r);
  if (truth.times >= 2) buckets.multi.push({ r, truth, cur, truthText });
  if (!truth.word) { buckets.noWord.push({ r, truth, cur, truthText }); continue; }
  if (!cur.acted) buckets.missed.push({ r, truth, cur, truthText });
  else if (cur.acted === truth.word || samePlan(cur.acted, truth.word)) buckets.ok.push({ r, truth, cur, truthText });
  else buckets.wrongWord.push({ r, truth, cur, truthText });
}

const t = usable.length;
console.log('  === 对照 0.6B 老师的答案（' + t + ' 条）===');
console.log('    ✔ 动作正确（含同义词等价）: ' + buckets.ok.length);
console.log('    ✘ 执行了错的词:             ' + buckets.wrongWord.length);
console.log('    ✘ 该执行却丢弃（漏响）:     ' + buckets.missed.length);
console.log('    ✘ 不该执行却执行:           ' + buckets.falseFire.length);
console.log('    · 老师也没听到关键词:       ' + buckets.noWord.length);
console.log('    ⚠ 同一段里那个词≥2次:      ' + buckets.multi.length);

const show = (name, arr, n = 10) => {
  if (!arr.length) return;
  console.log('');
  console.log('  【' + name + '】' + arr.length + ' 条:');
  for (const x of arr.slice(0, n)) {
    console.log('    ' + x.r.file + '  候选「' + x.r.ourText + '」  老师「' + x.truthText + '」→答案「' + (x.truth.word || '-') + '」'
      + '  M2「' + (x.r.m2Text || '') + '」  → 动作:' + (x.cur.acted ? '「' + x.cur.acted + '」' : '丢弃') + ' [' + x.cur.rule + ']');
  }
};
show('执行了错的词', buckets.wrongWord);
show('漏响', buckets.missed);
show('同段≥2次（前面喊失败了）', buckets.multi);
