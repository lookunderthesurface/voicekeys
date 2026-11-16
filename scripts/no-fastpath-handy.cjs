// 关掉唤醒/结束词的"快速通道"
//
// 证据：日志 11:39:24.457「快速通道: 我说完了（M1 1.00，跳过 M2）」——用户当时只是在
// 说话（"我刚才说完结束词"），M1 却给出 1.00 并直接执行了关录音。快速通道对普通命令词
// 有价值（省一次 M2），但对唤醒/结束词代价太大：一次误判就翻转 Handy 的开关状态。
// 这两个词一天也就用几十次，多花 40ms 问一下 M2 完全值得。
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(path.resolve(__dirname, '..'), 'app', 'server.js');
let src = fs.readFileSync(file, 'utf8');

const old = '    const fast = pipeline.policy.shouldFastPath({ score: cand.score, isHandy: candIsHandy, voicedMs });';
const neu = [
  '    // 唤醒/结束词不走快速通道：误判一次就翻转 Handy 开关，代价太大（2026-11-16 实测误触发）',
  "    const fast = candIsHandy ? false : pipeline.policy.shouldFastPath({ score: cand.score, isHandy: candIsHandy, voicedMs });",
].join('\n');

if (!src.includes('candIsHandy ? false')) {
  if (!src.includes(old)) { console.log('  ✘ 没找到快速通道调用'); process.exit(1); }
  src = src.replace(old, neu);
  fs.writeFileSync(file, src);
  console.log('  已关掉 handy 词的快速通道');
} else {
  console.log('  已经是关掉的状态');
}
