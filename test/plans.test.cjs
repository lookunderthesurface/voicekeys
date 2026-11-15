// 批量压测：一批真实需求 -> 本地模型生成计划 -> 按期望自动评分。
//
//   node test/plans.test.cjs            # 默认 qwen3.5:2b
//   VOICEKEYS_MODEL=qwen3.5:9b node test/plans.test.cjs
//
// 只生成计划，不执行（避免测试反复改系统音量）。执行链路由 selftest.cjs 负责。
const { planFromText } = require('../src/ai');

// expected: 允许的 op 序列（去掉 ui.toast 这类纯提示后比较）
// params: 关键参数校验函数
const CASES = [
  { say: '音量调到五十', ops: ['audio.volume.set'], check: (s) => s[0].percent === 50 },
  { say: '声音小一点', ops: ['audio.volume.delta'], check: (s) => s[0].percent < 0 },
  { say: '声音大一点', ops: ['audio.volume.delta'], check: (s) => s[0].percent > 0 },
  { say: '静音', ops: ['audio.mute.toggle'], check: () => true },
  { say: '取消静音', ops: ['audio.mute.set'], check: (s) => s[0].value === false },
  { say: '静音五秒后恢复', ops: ['audio.mute.toggle', 'flow.wait', 'audio.mute.toggle'], check: (s) => s[1].ms === 5000 },
  { say: '亮度调到三十', ops: ['display.brightness.set'], check: (s) => s[0].percent === 30 },
  { say: '亮度调暗一点', ops: ['display.brightness.delta'], check: (s) => s[0].percent < 0 },
  { say: '暂停', ops: ['key.press'], check: (s) => s[0].key === 'media_play_pause' },
  { say: '继续播放', ops: ['key.press'], check: (s) => s[0].key === 'media_play_pause' },
  { say: '下一首', ops: ['key.press'], check: (s) => s[0].key === 'media_next' },
  { say: '上一首', ops: ['key.press'], check: (s) => s[0].key === 'media_prev' },
  { say: '停止播放', ops: ['key.press'], check: (s) => s[0].key === 'media_stop' },
  { say: '音量调到三十再等一秒调到七十', ops: ['audio.volume.set', 'flow.wait', 'audio.volume.set'], check: (s) => s[0].percent === 30 && s[2].percent === 70 },
  { say: '音量调大三次', ops: ['flow.repeat'], check: (s) => s[0].times === 3 && s[0].body[0].op === 'audio.volume.delta' },
  { say: '音量调到两百', ops: ['audio.volume.set'], check: (s) => s[0].percent === 100 },
  { say: '亮度调到零', ops: ['display.brightness.set'], check: (s) => s[0].percent === 5 },
  { say: '声音调到最大', ops: ['audio.volume.set'], check: (s) => s[0].percent === 100 },
  { say: '声音调到最小', ops: ['audio.volume.set'], check: (s) => s[0].percent === 0 },
  // 下面这些不属于安全原语：正确答案是"拒绝/不用原语硬凑"
  { say: '打开微信', refuse: true },
  { say: '今天天气怎么样', refuse: true },
  { say: '把屏幕关掉', refuse: true },
];

const strip = (steps) => {
  const out = [];
  const walk = (list) => {
    for (const s of list || []) {
      if (s.op === 'ui.toast') continue;
      if (s.op === 'flow.repeat') out.push({ ...s, body: strip(s.body) });
      else out.push(s);
    }
  };
  walk(steps);
  return out;
};

(async () => {
  const model = process.env.VOICEKEYS_MODEL || undefined;
  const rows = [];
  for (const c of CASES) {
    const gen = await planFromText(c.say, model ? { model } : undefined);
    let verdict = 'FAIL';
    let detail = '';
    if (c.refuse) {
      // 拒绝的标准：生成失败，或者动作里没有硬凑的系统原语
      const ops = gen.ok ? strip(gen.plan.steps).map((s) => s.op) : [];
      const usedSystem = ops.some((op) => !op.startsWith('custom.'));
      verdict = !gen.ok || !usedSystem ? 'PASS' : 'FAIL';
      detail = gen.ok ? ops.join('+') : (gen.errors || []).join(';');
    } else if (gen.ok) {
      const steps = strip(gen.plan.steps);
      const ops = steps.map((s) => s.op);
      const opsOk = JSON.stringify(ops) === JSON.stringify(c.ops);
      let paramOk = true;
      try { paramOk = c.check ? c.check(steps) : true; } catch { paramOk = false; }
      verdict = opsOk && paramOk ? 'PASS' : 'FAIL';
      detail = ops.join(' -> ') + (paramOk ? '' : '  (参数不符)');
    } else {
      detail = (gen.errors || []).join(';');
    }
    rows.push({ say: c.say, verdict, detail, ms: gen.ms, attempts: gen.attempts });
    console.log(`  ${verdict === 'PASS' ? 'PASS' : 'FAIL'}  ${c.say.padEnd(18)} ${String(gen.ms).padStart(4)}ms  ${detail}`);
  }

  const pass = rows.filter((r) => r.verdict === 'PASS').length;
  const avg = Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length);
  console.log(`\n  ${pass}/${rows.length} 通过   平均 ${avg}ms   模型 ${model || '默认(2b)'}`);
  const failed = rows.filter((r) => r.verdict === 'FAIL');
  if (failed.length) console.log('  失败：' + failed.map((f) => f.say).join('、'));
  process.exit(pass === rows.length ? 0 : 1);
})();
