// 以 0.6B 老师为唯一答案：算召回率、核对"没听到关键词"的录音、列出喊了多遍的录音
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
const planOf = new Map(verbose.map((p) => [p.say, JSON.stringify((p.plan && p.plan.steps) || [])]));
const live = new Set(verbose.map((p) => p.say));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const usable = rows.filter((r) => live.has(r.ourText));
const TH = 0.7;
const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
const samePlan = (a, b) => a && b && planOf.get(a) === planOf.get(b);

function truth(text) {
  const t = norm(text);
  if (!t) return { word: null, times: 0, how: 'empty' };
  const hits = words.filter((w) => t.includes(norm(w.word))).sort((a, b) => norm(b.word).length - norm(a.word).length);
  if (hits.length) {
    const w = hits[0].word;
    return { word: w, times: t.split(norm(w)).length - 1, how: 'literal' };
  }
  const all = matcher.scoreAll(t, words);
  const top = all[0];
  if (top && top.score >= TH) return { word: top.word, times: 1, how: 'fuzzy' };
  return { word: null, times: 0, how: 'none', best: top };
}

function action(r) {
  if (r.verdict === 'fast-path') return { acted: r.ourText, rule: 'fast-path' };
  const scored = matcher.scoreAll(r.m2Text || '', words);
  const v = policy.verdictFromScores({ candidate: r.ourText, m1Score: Number(r.bestScore) || 0, scored, thresholdOf: () => TH });
  return { acted: (v.action === 'fire' || v.action === 'swap') ? v.word : null, rule: v.rule };
}

let withWord = 0, correct = 0, wrong = 0, missed = 0;
let occurrences = 0;          // 老师听到的关键词总次数（≈ 用户实际喊的次数）
const multi = [];
const noWord = [];

for (const r of usable) {
  const text = cache[r.file] || '';
  const t = truth(text);
  const a = action(r);
  if (!t.word) {
    noWord.push({ r, text, t, a });
    continue;
  }
  withWord += 1;
  occurrences += Math.max(1, t.times);
  if (!a.acted) missed += 1;
  else if (a.acted === t.word || samePlan(a.acted, t.word)) correct += 1;
  else wrong += 1;
  if (t.times >= 2) multi.push({ r, text, t, a });
}

console.log('  === 以 0.6B 老师为答案（' + usable.length + ' 条录音）===');
console.log('  老师听到明确关键词的录音: ' + withWord);
console.log('    动作正确: ' + correct);
console.log('    动作错: ' + wrong);
console.log('    该动没动: ' + missed);
console.log('');
console.log('  【录音级召回率】正确 / 有关键词的录音 = ' + correct + '/' + withWord + ' = ' + Math.round((correct / withWord) * 100) + '%');
console.log('  【尝试级召回率】正确 / 老师数出的喊词次数 = ' + correct + '/' + occurrences + ' = ' + Math.round((correct / occurrences) * 100) + '%');
console.log('    （老师在同一段里听到 ≥2 次的，说明前面有没响应的尝试）');
console.log('');
console.log('  === "老师没听到任何关键词"的录音：' + noWord.length + ' 条 ===');
const emptyText = noWord.filter((x) => !String(x.text).trim()).length;
console.log('    其中老师转写为空（纯静音/噪声）: ' + emptyText);
console.log('    其中老师听到人声但没有任何关键词: ' + (noWord.length - emptyText));
const byAction = {};
for (const x of noWord) byAction[x.a.acted || '(丢弃)'] = (byAction[x.a.acted || '(丢弃)'] || 0) + 1;
console.log('    这些录音当时做了什么动作: ' + JSON.stringify(byAction));
console.log('    → 老师听不到关键词却触发了，即【误触发】');
console.log('');
console.log('  === 喊了多遍的录音（老师听到同一词 ≥2 次）: ' + multi.length + ' 条 ===');
for (const m of multi) {
  console.log('    ' + m.r.file + '  ' + (m.r.at || '').slice(11, 19) + '  词「' + m.t.word + '」 老师听到 ' + m.t.times + ' 次');
  console.log('        老师转写：「' + m.text + '」');
  console.log('        当时动作: ' + (m.a.acted ? '执行「' + m.a.acted + '」' : '丢弃') + '  [' + m.a.rule + ']  M2转写「' + (m.r.m2Text || '') + '」');
}
