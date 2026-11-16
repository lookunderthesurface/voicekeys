// 用真实录音验证新的 M2 裁决：对每条素材，用 M2 真实转写 + 候选词评分，看能不能认出当时的词
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const { readWav } = require(path.join(ROOT, 'lib', 'runtime', 'listener', 'audio.cjs'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const { Confirmer } = require(path.join(ROOT, 'app', 'confirmer.js'));

const CAP = config.DIRS.capture;
const rows = fs.readFileSync(path.join(CAP, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const words = planner.listVerbose().map((p) => ({ word: p.say, planKey: p.say }));
const live = new Set(words.map((w) => w.word));

// 只测"当时的词现在还在词表里"的素材（旧标签如「站停视频」已删，没法测）
const testable = rows.filter((r) => live.has(r.ourText));
console.log('  素材 ' + rows.length + ' 条，可测 ' + testable.length + ' 条（词还在词表里）');

(async () => {
  const confirmer = new Confirmer({ log: () => {} });
  confirmer.start();
  for (let i = 0; i < 40; i += 1) { await new Promise((r) => setTimeout(r, 250)); if (confirmer.state().ready) break; }

  let ownOk = 0, ownLow = 0, swapped = 0;
  const lowSamples = [];
  for (const row of testable) {
    const file = path.join(CAP, row.file);
    if (!fs.existsSync(file)) continue;
    const wav = readWav(file);
    const samples = wav.samples || wav;
    const out = await confirmer.confirm(samples, 3000);
    const text = (out && out.text) || '';
    const own = matcher.findWord(text, [{ word: row.ourText, planKey: row.ourText }], 0);
    const ownScore = own ? own.score : 0;
    const best = matcher.findWord(text, words, 0.7);
    if (ownScore >= 0.7) ownOk += 1;
    else {
      ownLow += 1;
      if (best) swapped += 1;
      if (lowSamples.length < 10) lowSamples.push({ file: row.file, word: row.ourText, ownScore, best: best ? best.word + '(' + best.score.toFixed(2) + ')' : 'null', text });
    }
  }
  confirmer.stop('done');
  console.log('');
  console.log('  候选词自己达标(≥0.7): ' + ownOk);
  console.log('  候选词自己不够: ' + ownLow + '（其中会被改判成别的词: ' + swapped + '）');
  if (lowSamples.length) {
    console.log('');
    console.log('  不够的样例:');
    for (const s of lowSamples) console.log('    ' + s.file + ' 期望「' + s.word + '」 自身分 ' + s.ownScore.toFixed(2) + ' 最佳 ' + s.best + '  M2「' + s.text + '」');
  }
})();
