# 扩展 VoiceKeys（给人和给 AI 看的）

这份文档的目的是：**你可以把它整段丢给任何一个 AI**，让它照着给你写扩展。

VoiceKeys 有两个扩展区，规则不同：

| 区 | 在哪 | 谁在写 | 有没有约束 |
|---|---|---|---|
| **L1 内置生成** | 界面里的「生成计划」 | 我们内置的模型 | 有：只能从 11 个原语里选，参数会被夹紧 |
| **L2/L3 自定义** | `custom/` 与源码本身 | **你**（通常让别的 AI 写） | **没有**：想写什么写什么 |

本文件主要讲 L2/L3。

---

## 一、自定义动作（L2）

### 契约

在 `custom/` 下放一个同名文件，程序按名字调用：

```
custom/
  say-hello.json     ← 描述（可选，给人看的）
  say-hello.cmd      ← 真正执行的东西（.cmd / .ps1 / .exe 都行）
```

**输入**：环境变量
- `VOICEKEYS_PHRASE`：触发这次动作的关键词
- `VOICEKEYS_ARGS`：计划里 `args` 字段的 JSON 字符串

**输出**：往 stdout 打印一段 JSON，会被记进日志：
```json
{ "ok": true, "note": "随便写点什么" }
```

**要求**（尽量）：别卡住超过 5 秒；失败了返回 `{"ok": false, "error": "..."}`。

### 示例：让 AI 帮你写一个"打开某个网址"的动作

把下面这段原样丢给 AI：

> 我在用 VoiceKeys，一个本地语音工具。它会在 `custom/` 目录里调用我写的脚本。
> 脚本通过环境变量 `VOICEKEYS_PHRASE` 拿到触发词，通过 `VOICEKEYS_ARGS` 拿到 JSON 参数，
> 往 stdout 打印 `{"ok":true}` 表示成功。
> 请帮我写一个 `open-url.cmd`：从 `VOICEKEYS_ARGS` 里读 `{"url": "..."}`，然后用默认浏览器打开这个网址。
> 只输出脚本内容，不要解释。

### 在计划里调用它

```json
{ "steps": [ { "op": "custom.open-url", "args": { "url": "https://example.com" } } ] }
```

---

## 二、改算法（L3）

所有算法都是可读、可改的 JS，没有编译步骤：

| 想改什么 | 改哪个文件 |
|---|---|
| 匹配规则（多严格、能否缺字、拼音权重） | `app/matcher.js` |
| 静音门、首部门、冷却 | `app/trigger.js` |
| 触发之后怎么执行 | `app/executor.js`、`src/core.js` |
| 新增原语 | `src/core.js` 的 `PRIMITIVES` 数组 |
| 采集哪些段、存多少 | `app/capture.js` |
| 报表怎么分类、怎么建议 | `app/report.js` |
| 界面 | `app/ui.html` |
| HTTP 接口 | `app/server.js` |

### 原语的形状

```js
{
  id: 'audio.volume.set',        // 唯一名，计划里用 op 引用
  kind: 'system',                // system / flow / custom
  desc: '把系统音量设到指定百分比',
  params: { percent: { min: 0, max: 100, default: 50 } },
  reversible: true,
  risk: 'safe',
  toWorker: (p) => ({ op: 'audio.set', value: p.percent / 100 }),   // 交给 PowerShell worker
  // 或者 run(p, ctx) —— 需要多步时用这个
}
```

`validatePlan` 会根据 `params` 自动夹紧范围、拒绝未知 `op`。**这一层是给 L1 用的保险**；你直接调原语或写 `custom.*` 时它不拦你。

### 改之前先打快照

界面上点「给当前代码打快照」，或者：

```powershell
git -C . commit -am "before my experiment"
```

改坏了：界面「选择恢复」→ 挑一个版本。恢复前的改动会进 `git stash`。

---

## 三、写扩展时值得知道的现状（2026-11）

这些是我踩过的坑，写之前知道能省时间：

1. **触发用的是流式 ASR，不是关键词检测**。文本出来后做整句比对，所以"关键词"其实是"整句话要像这个词"。
2. **匹配分数 0~1**，默认阈值 0.70。低于 0.40 基本可判定与所有词无关。
3. **同一个词 2.5 秒内只触发一次**（ASR 会重复吐同一句）。
4. **静音门**：唤醒词 0ms、结束词 600ms、命令词 1000ms，存在 `plans.json` 的 `pauseMs`。
5. **执行层是常驻 PowerShell**，不是每条命令起进程；原语延迟 30–250ms。
6. **媒体控制是"切窗口 + 空格"**，天生是切换语义，没有播放状态可查。
7. **老师的复核跑在 transcribe-cpp 上**（MIT），模型是 Qwen3-ASR-0.6B GGUF，一次加载约 1.5 秒。

---

## 四、不要做的事（不是为了限制你，是为了别浪费时间）

- 别指望用"音量/亮度"这类系统状态去猜媒体是否在播——试过，拿不到
- 别在触发路径里加同步阻塞调用（会把音频帧丢掉）
- 别把模型塞进仓库（几百 MB，且各有各的许可）
