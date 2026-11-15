// 默认静音门策略：唤醒/结束词不等待、忽略"还在说"；命令词等一会儿、严格。
// 想改"等多久"或"什么情况下算还在说话"，照这个接口写一个新文件即可。
//
// 契约（必须实现）：
//   pauseMs(meta)     -> number   命中后等多少毫秒静音才执行
//   ignoreNoisy(meta) -> boolean  true = 门内继续说话也不取消（唤醒/结束词需要）
// meta: { pauseMs, noLead, ignoreNoisy, word }
module.exports = {
  name: 'default-pause-gate',
  pauseMs(meta) {
    const v = Number(meta && meta.pauseMs);
    return Number.isFinite(v) && v >= 0 ? v : 1000;
  },
  ignoreNoisy(meta) {
    // handy.set 类（唤醒/结束）由上层在 meta.ignoreNoisy 里标好；
    // 这里再兜一层：pauseMs 为 0 的词天然不该因为"还在说"被取消
    if (meta && meta.ignoreNoisy) return true;
    return Number(meta && meta.pauseMs) === 0;
  },
};
