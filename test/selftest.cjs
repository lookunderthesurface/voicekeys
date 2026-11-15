// 自测：不碰麦克风、不碰语音，只验证「原语 -> 校验 -> 执行 -> 回读」这条链路。
//
//   node test/selftest.cjs
//
// 规矩：先快照音量/亮度，跑完恢复并回读确认。
const { spawnSync } = require('node:child_process');
const { validatePlan, Worker, execute, PRIMITIVES, listCustomActions, runCustomAction } = require('../src/core');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  // ---------------------------------------------------------------- 1) 校验器
  const tooBig = validatePlan({ steps: [{ op: 'audio.volume.set', percent: 150 }] });
  check('参数越界被钳制到 100', tooBig.ok && tooBig.plan.steps[0].percent === 100, JSON.stringify(tooBig.warnings));

  const unknown = validatePlan({ steps: [{ op: 'system.shutdown' }] });
  check('未知动作被拒绝', !unknown.ok, unknown.errors.join(';'));

  const bigRepeat = validatePlan({ steps: [{ op: 'flow.repeat', times: 1000, body: [{ op: 'flow.wait', ms: 10 }] }] });
  check('repeat 被钳制到 50', bigRepeat.ok && bigRepeat.plan.steps[0].times === 50);

  const manySteps = validatePlan({ steps: Array.from({ length: 40 }, () => ({ op: 'flow.wait', ms: 10 })) });
  check('步数超限被拒绝', !manySteps.ok, manySteps.errors.join(';'));

  const badKey = validatePlan({ steps: [{ op: 'key.press', key: 'f12' }] });
  check('不允许的按键被拒绝', !badKey.ok, badKey.errors.join(';'));

  // ---------------------------------------------------------------- 2) 真实系统（快照 -> 跑 -> 恢复）
  const worker = new Worker();
  const before = await worker.call({ op: 'audio.get' });
  console.log(`  初始音量 ${Math.round(before.volume * 100)}%  静音=${before.muted}`);

  const plan = {
    steps: [
      { op: 'audio.volume.set', percent: 40 },
      { op: 'audio.volume.delta', percent: -10 },
    ],
  };
  const v = validatePlan(plan);
  const run = await execute(v.plan, { worker });
  const mention = run.results[run.results.length - 1];
  const vol = await worker.call({ op: 'audio.get' });
  check('音量 40 再 -10 = 30%', Math.abs(vol.volume * 100 - 30) <= 2, `实测 ${Math.round(vol.volume * 100)}% (${run.elapsedMs}ms)`);

  // 静音两次应回到原状态
  await execute(validatePlan({ steps: [{ op: 'audio.mute.toggle' }] }).plan, { worker });
  const once = await worker.call({ op: 'audio.get' });
  await execute(validatePlan({ steps: [{ op: 'flow.wait', ms: 1200 }, { op: 'audio.mute.toggle' }] }).plan, { worker });
  const twice = await worker.call({ op: 'audio.get' });
  check('静音翻转一次、再翻转回来', once.muted === true && twice.muted === false, `once=${once.muted} twice=${twice.muted}`);

  // 条件分支：当前不静音时，if(muted) 不应执行 body
  const ifPlan = validatePlan({ steps: [{ op: 'flow.if', when: 'muted', value: 50, body: [{ op: 'audio.volume.set', percent: 90 }] }] }).plan;
  const beforeIf = await worker.call({ op: 'audio.get' });
  await execute(ifPlan, { worker });
  const afterIf = await worker.call({ op: 'audio.get' });
  check('if(muted) 为假时不执行 body', Math.abs(afterIf.volume - beforeIf.volume) < 0.01);

  // 亮度：台式显示器可能不支持，两种结果都算通过
  const b = await worker.call({ op: 'display.get' });
  check('亮度读取（台式机不支持也算通过）', b.ok === true || /no internal display|不支持|not supported/i.test(b.error || ''), b.ok ? `brightness=${b.brightness}` : b.error);

  // ---------------------------------------------------------------- 3) 自定义动作入口
  const custom = listCustomActions();
  check('自定义动作可被发现', custom.some((c) => c.id === 'custom.say-hello'), JSON.stringify(custom.map((c) => c.id)));
  const hello = await runCustomAction(custom.find((c) => c.id === 'custom.say-hello'), { name: '挥手' });
  check('自定义动作可执行（stdin JSON -> stdout）', hello.ok && /echo/.test(hello.stdout || ''), (hello.stdout || hello.error || '').trim().slice(0, 80));

  // ---------------------------------------------------------------- 4) 恢复原状
  await worker.call({ op: 'audio.set', value: before.volume });
  await worker.call({ op: 'audio.mute', value: false });   // 测试里最后处于未静音
  const restored = await worker.call({ op: 'audio.get' });
  check('音量/静音已恢复', Math.abs(restored.volume - before.volume) < 0.02 && restored.muted === false, `${Math.round(restored.volume * 100)}% muted=${restored.muted}`);

  worker.stop();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})();
