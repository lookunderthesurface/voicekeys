// 一键自测：不需要麦克风，跑完把关键行为都验一遍。
//
//   node test/selftest-all.cjs
//
// 覆盖：匹配器行为、计划校验、自定义动作、采集规则、报表分类。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const core = require(path.join(ROOT, 'src', 'core.js'));
const { matchOne, bestScore, editDistance, toPinyin } = require(path.join(ROOT, 'app', 'matcher.js'));
const { Capture } = require(path.join(ROOT, 'app', 'capture.js'));
const { buildReport } = require(path.join(ROOT, 'app', 'report.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  \u2714 ${name}`); }
  else { fail += 1; console.log(`  \u2718 ${name}${detail ? '  ' + detail : ''}`); }
}

// ---------------------------------------------------------------- 1. 匹配器
const WORDS = [
  ['声音大一点', '[{"op":"audio.volume.delta","percent":10}]'],
  ['声音小一点', '[{"op":"audio.volume.delta","percent":-10}]'],
  ['静音', '[{"op":"audio.mute.toggle"}]'],
  ['播放视频', '[{"op":"media.toggle","action":"play"}]'],
  ['暂停视频', '[{"op":"media.toggle","action":"pause"}]'],
  ['暂停播放', '[{"op":"media.toggle","action":"pause"}]'],
  ['暂停爱奇艺', '[{"op":"media.toggle","action":"pause","app":"QyWindow"}]'],
  ['把声音调大', '[{"op":"audio.volume.delta","percent":10}]'],
  ['把声音调小', '[{"op":"audio.volume.delta","percent":-10}]'],
  ['发送', '[{"op":"key.press","key":"enter"}]'],
  ['听我说', '[{"op":"handy.set","target":"on"}]'],
  ['我说完了', '[{"op":"handy.set","target":"off"}]'],
].map(([word, planKey]) => ({ word, planKey }));

console.log('\n[1] 匹配器');
const shouldFire = [
  ['听我说', '听我说'], ['听我', '听我说'], ['暂停', '暂停视频'], ['暂停视', '暂停视频'],
  ['播放视', '播放视频'], ['不播放视频', '播放视频'], ['把声调小', '把声音调小'],
  ['我完了', '我说完了'], ['偶说完了', '我说完了'], ['声音大', '声音大一点'],
];
for (const [text, expect] of shouldFire) {
  const m = matchOne(text, WORDS);
  check(`「${text}」→ ${expect}`, Boolean(m && !m.ambiguous && m.word === expect), m ? JSON.stringify(m) : 'null');
}
const shouldNotFire = ['我吃过了', '今天天气不错', '完全无关的话', '视频播放器在哪里', '播放音乐', '哦哦', '嗯', '定视频'];
for (const text of shouldNotFire) {
  const m = matchOne(text, WORDS);
  check(`「${text}」不触发`, !m || Boolean(m.ambiguous), m ? JSON.stringify(m) : '');
}
check('同计划的词打平不算歧义（暂停视频/暂停播放）', (() => {
  const m = matchOne('暂停', WORDS);
  return m && !m.ambiguous;
})());

// ---------------------------------------------------------------- 2. 计划校验
console.log('\n[2] 计划校验');
check('合法计划通过', core.validatePlan({ steps: [{ op: 'audio.volume.set', percent: 40 }] }).ok);
check('未知动作被拒', !core.validatePlan({ steps: [{ op: 'audio.nuke' }] }).ok);
check('参数被钳制', (() => {
  const v = core.validatePlan({ steps: [{ op: 'audio.volume.set', percent: 999 }] });
  return v.ok && v.plan.steps[0].percent === 100;
})());
check('流程步骤超过上限被拒', !core.validatePlan({ steps: Array.from({ length: 40 }, () => ({ op: 'flow.wait', ms: 10 })) }).ok);

// ---------------------------------------------------------------- 3. 自定义动作
console.log('\n[3] 自定义动作');
const CUSTOM = path.join(ROOT, 'custom');
const probeId = 'custom.__selftest';
const probeJson = path.join(CUSTOM, '__selftest.json');
const probeCmd = path.join(CUSTOM, '__selftest.cmd');
const probeLog = path.join(os.tmpdir(), 'vk-selftest-probe.log');
fs.writeFileSync(probeJson, JSON.stringify({ id: probeId, desc: 'selftest', exec: '__selftest.cmd', timeoutMs: 5000 }));
fs.writeFileSync(probeCmd, '@echo off\r\necho fired >> "%TEMP%\\vk-selftest-probe.log"\r\necho {"ok":true}\r\n');
try {
  fs.unlinkSync(probeLog);
} catch { /* none */ }
check('custom.* 通过校验', core.validatePlan({ steps: [{ op: probeId }] }).ok);
(async () => {
  const w = new core.Worker();
  try {
    const r = await core.execute({ steps: [{ op: probeId }] }, { worker: w });
    check('custom.* 能真正执行', r.results[0].ok === true, JSON.stringify(r.results[0]));
  } finally {
    w.stop();
    try { fs.unlinkSync(probeJson); } catch { /* ignore */ }
    try { fs.unlinkSync(probeCmd); } catch { /* ignore */ }
    try { fs.unlinkSync(probeLog); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------- 4. 采集规则
  console.log('\n[4] 采集规则');
  const tmpDir = path.join(os.tmpdir(), 'vk-cap-selftest');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const cap = new Capture(tmpDir);
  const frame = () => new Float32Array(1600).fill(0.2);
  const push = (n) => { for (let i = 0; i < n; i += 1) cap.pushFrame(frame(), 0.2); };

  // 触发过的段：一定存
  push(20);
  cap.markFired('静音');
  const r1 = cap.finish('静音', bestScore('静音', WORDS));
  check('触发过的段被保存', r1.saved === true && r1.entry.why === 'fired');

  // 完全无关且长：不存
  push(20);
  const r2 = cap.finish('今天天气不错', bestScore('今天天气不错', WORDS));
  check('无关长句不保存', r2.saved === false, JSON.stringify(r2));

  // 模糊带（0.40~0.85）：存
  push(20);
  const borderline = bestScore('定视频', WORDS);
  const r3 = cap.finish('定视频', borderline);
  check('模糊带被保存', r3.saved === true && r3.entry.why === 'borderline', JSON.stringify(r3.entry || r3));

  // 纯静音：不存
  const cap2 = new Capture(path.join(os.tmpdir(), 'vk-cap-selftest2'));
  for (let i = 0; i < 20; i += 1) cap2.pushFrame(new Float32Array(1600), 0);
  const r4 = cap2.finish('', null);
  check('纯静音不保存', r4.saved === false, JSON.stringify(r4));

  // 采样策略：同一个词反复满分命中，过了配额就不该再占坑（"已优化词"不喂样本）
  const cap3 = new Capture(path.join(os.tmpdir(), 'vk-cap-selftest3'));
  let kept = 0;
  for (let i = 0; i < 20; i += 1) {
    for (let k = 0; k < 20; k += 1) cap3.pushFrame(frame(), 0.2);
    cap3.markFired('静音');
    const r = cap3.finish('静音', bestScore('静音', WORDS));
    if (r.saved) kept += 1;
  }
  check('同一词反复命中只保留少量样本（配额生效）', kept > 0 && kept <= 8, `实际保留 ${kept} 段`);

  // 容量上限：直接把 count 顶到 max，再交一段就不该存
  cap3.count = cap3.max;
  for (let k = 0; k < 20; k += 1) cap3.pushFrame(frame(), 0.2);
  const r5 = cap3.finish('静音', bestScore('静音', WORDS));
  check('存满后不再保存', cap3.full === true && r5.saved === false, JSON.stringify(r5));

  // 模糊带优先于"已优化词配额"：即使该词已经很稳，边界样本仍要留
  const { optimizedWords, wordStats, decide } = require(path.join(ROOT, 'app', 'sampling.js'));
  const rows = Array.from({ length: 5 }, () => ({ teacherWord: '静音', fired: true, firedWord: '静音', bestWord: '静音' }));
  const stats = wordStats([], { rows });
  check('满分会话被判定为已优化词', optimizedWords(stats).has('静音'), JSON.stringify(stats));
  const bandSample = decide({ text: '定视频', score: 0.5, fired: false, voicedMs: 800, ms: 1200, bestWord: '静音' }, { entries: [], stats });
  check('模糊带样本不受已优化词配额限制', bandSample.keep === true && bandSample.reason === 'borderline', JSON.stringify(bandSample));

  // -------------------------------------------------------------- 4.5 评分账本
  console.log('\n[4.5] 评分账本');
  {
    const ledgerMod = require(path.join(ROOT, 'app', 'scoreledger.js'));
    const entries = [
      { id: '1', fired: true, firedWord: '静音' },
      { id: '2', fired: true, firedWord: '静音' },
      { id: '3', fired: false, firedWord: '' },
      { id: '4', fired: false, firedWord: '' },
    ];
    const rows = [
      { id: '1', teacherWord: '静音' },
      { id: '2', teacherWord: '' },
      { id: '3', teacherWord: '暂停视频' },
      { id: '4', teacherWord: '' },
    ];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const r = ledgerMod.apply(ledgerMod.emptyLedger(), rows, byId);
    check('真真 +1/+1、误触发只加分母、漏检扣分子', r.ledger.numerator === 0 && r.ledger.denominator === 2, JSON.stringify(r.ledger));
    const again = ledgerMod.apply(r.ledger, rows, byId);
    check('同一条录音不会重复结算', again.counted === 0, JSON.stringify(again.delta));
  }

  // -------------------------------------------------------------- 5. 报表分类
  console.log('\n[5] 报表分类');
  const entries = [
    { id: '1', file: 'a.wav', ourText: '暂停视频', fired: true, firedWord: '暂停视频' },
    { id: '2', file: 'b.wav', ourText: '定视频', fired: false },
    { id: '3', file: 'c.wav', ourText: '播放视频', fired: true, firedWord: '播放视频' },
    { id: '4', file: 'd.wav', ourText: '我吃过了', fired: false },
    { id: '5', file: 'e.wav', ourText: '把声音调', fired: false },
  ];
  const teacher = { 'a.wav': '暂停视频。', 'b.wav': '暂停视频。', 'c.wav': '播放视频。', 'd.wav': '我吃过了。', 'e.wav': '把声音调小。' };
  const rep = buildReport(entries, teacher, WORDS);
  const byId = Object.fromEntries(rep.rows.map((r) => [r.id, r]));
  check('真命中识别正确', byId['1'].verdict === '一致（真命中）', byId['1'].verdict);
  check('模型听错的漏检识别正确', byId['2'].verdict.startsWith('漏检'), byId['2'].verdict);
  check('一致不触发识别正确', byId['4'].verdict === '一致（不触发）', byId['4'].verdict);
  check('歧义拦下识别正确', byId['5'].verdict.startsWith('歧义拦下'), byId['5'].verdict);
  check('汇总数字自洽', rep.summary.total === 5 && rep.summary.falseNegative === 1, JSON.stringify(rep.summary));

  // -------------------------------------------------------------- 6. 拼音
  console.log('\n[6] 拼音');
  check('同音字距离小（偶说完了/我说完了）', editDistance(toPinyin('偶说完了'), toPinyin('我说完了')) === 1);
  check('无关句距离大（今天天气不错/暂停视频）', editDistance(toPinyin('今天天气不错'), toPinyin('暂停视频')) > 3);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'vk-cap-selftest2'), { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'vk-cap-selftest3'), { recursive: true, force: true });

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
