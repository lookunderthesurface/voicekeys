# 算法层（可以替换的部分）

VoiceKeys 把"没有唯一正确答案"的策略抽成了 4 个**可替换角色**。你（或者你让 AI）只要照契约写一个 JS 文件，放进 `user/`，在 `app/settings.json` 里指过去，**不用改主程序**。

## 角色与契约

| 角色 | 文件 | 必须实现 | 作用 |
|---|---|---|---|
| `matcher` | `matcher.default.js` | `match(text, words, opts)`、`bestScore(text, words)` | 决定"这句话像不像某个词" |
| `sampler` | `sampler.default.js` | `decide(sample, ctx)` | 决定"这段录音值不值得存下来" |
| `gate` | `gate.default.js` | `pauseMs(meta)`、`ignoreNoisy(meta)` | 决定"命中后等多久、什么算还在说话" |
| `reporter` | `../report.js`（暂未接入） | — | 决定"复核报表怎么分类、给什么建议" |

## 怎么替换

1. 在 `app/algorithms/user/` 新建文件，例如 `my-matcher.js`：

```js
// 例子：只认完全一致的词（最严格，零误触发，但容易漏）
module.exports = {
  name: 'exact-only',
  match(text, words, opts = {}) {
    const t = (text || '').replace(/[\s，。,.!！?？]/g, '');
    for (const w of words) {
      const wk = (w.word || '').replace(/[\s，。,.!！?？]/g, '');
      if (t === wk) return { word: w.word, planKey: w.planKey, score: 1, how: 'exact' };
    }
    return null;
  },
  bestScore(text, words) {
    let best = null;
    for (const w of words) {
      if ((text || '').trim() === w.word) best = { word: w.word, planKey: w.planKey, score: 1, how: 'exact' };
    }
    return best;
  },
};
```

2. 在 `app/settings.json` 里加（可以只写你要换的那一个）：

```json
{
  "algorithms": {
    "matcher": "my-matcher.js"
  }
}
```

3. 重启应用。启动日志/`/api/algorithms` 会显示当前生效的实现。

**写错了不会把应用搞挂**：加载失败会记一条警告并回退默认实现，`/api/algorithms` 里能看到 `error`。

## 测试你的算法

```powershell
node test/selftest-all.cjs      # 内置 40 项（用默认实现）
node test/bench-pipeline.cjs    # 拿真人录音跑一遍命中率
```

改完算法先跑 `bench-pipeline`，看命中率是升还是降——**别凭感觉**。

## 当前默认实现的关键参数

`matcher.default.js` 背后是 `app/matcher.js`：

- 完全一致 = 1.0；是关键词的前缀 = 0.85；其余取"字符相似度"和"拼音相似度"的较大值
- 长度护栏：候选长度超过 `关键词长度 + max(2, 60%)` 直接不算
- 阈值默认 0.70（`settings.json` 的 `matchThreshold`）
- 多个候选打平（差值 < 0.05）：若只有一个"通用计划"就用它，否则判为歧义、不触发

`sampler.default.js` 背后是 `app/sampling.js`：按词统计一致率，≥0.80 且样本 ≥4 视为"已优化"，其命中样本最多留 1 段。

`gate.default.js`：`pauseMs` 默认 1000；`pauseMs=0` 或 `ignoreNoisy=true` 的词忽略"还在说"。
