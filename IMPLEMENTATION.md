# VoiceKeys 原型实现记录

> 代码在 `tools/voicekeys/`，Node 实现（先跑通，后面再考虑移植 Rust）。
> 这份记录只讲**已经做出来的东西**和**实测数据**，产品设计见 `DESIGN.md`。

## 1. 两个部分，代码上彻底分开

```
┌─────────────────────┐          ┌──────────────────────────────┐
│ ① 触发层（detector） │  一个词   │ ② 计划层（planner/executor）  │
│  听关键词、抗误触     │ ───────► │  把需求变成计划、把计划执行掉  │
│  （现有语音插件负责） │          │  （本目录的 src/）            │
└─────────────────────┘          └──────────────────────────────┘
        与音频相关                          与音频无关
```

**依赖方向是单向的**：计划层完全不知道麦克风、KWS、Handy 的存在，它只接受两个入口——一行文本（生成计划）或一份 JSON（执行计划）。所以：

- 触发层可以换成别的实现（Rust、AHK、甚至手机），计划层不用改一行；
- 计划层可以单独测试（现在的 12 项自测和 22 条压测都不需要麦克风）。

模块边界（`src/`）：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `core.js` | 原语表 + 计划校验 + worker 客户端 + 执行器 + 自定义动作 | 只依赖系统和 `runtime/worker.ps1` |
| `ai.js` | 一句需求 → 计划 JSON（Ollama） | 只依赖 `core.js` 的原语表 |
| `store.js` | 计划缓存（`plans.json`） | 无 |
| `cli.js` | 命令行入口 | 以上三者 |

## 2. 为什么是「先绑、后触发」

唤醒词模型（KWS）只能**认事先编好的几个词**，它不做语音识别。所以不可能"边说边让 AI 写程序"，正确做法是：

```
配置阶段（慢没关系）          运行阶段（要求稳定、零模型开销）
说一句需求 → 9B 生成计划 ──►  缓存 plans.json
                             喊关键词 → 查缓存 → 执行
```

实测：生成 1.2–1.9 秒（9B），执行 30–370ms（含 worker 启动）。**运行时完全不碰模型。**

## 3. 原语表（12 条，全部可逆、无持久副作用、参数有界）

| id | 参数 | 说明 |
|---|---|---|
| `audio.volume.set` | percent 0–100 | 绝对音量 |
| `audio.volume.delta` | ±100 | 相对增减 |
| `audio.mute.toggle` | — | 静音开关 |
| `audio.mute.set` | value: true/false | 显式静音/取消 |
| `display.brightness.set` | 5–100 | 内置屏亮度（下限 5 防黑屏） |
| `display.brightness.delta` | ±95 | 相对增减 |
| `key.press` | 白名单 11 个键 | space/enter/esc/方向/媒体四键 |
| `flow.wait` | 0–5000ms | 等待 |
| `flow.repeat` | 1–50 + body | 循环 |
| `flow.if` | when/value + body | 按当前状态分支 |
| `ui.toast` | 文本 ≤50 字 | 右下角 1.6 秒提示窗（已实现） |

**不在表里**：启动程序、关机、锁屏、写文件、执行命令、联网——这些只能走自定义动作。

## 4. 自定义动作契约（用户的地盘，我们不校验、不背书）

```
custom/<name>.json   {"id":"custom.xxx","params":{...},"exec":"run.cmd"}
custom/run.cmd       自己的脚本（.cmd/.bat/.ps1/.py/.exe 都行）
```

我们只做：读 json → 参数以 JSON 写进 stdin → 执行 → 读 stdout。示例见 `custom/say-hello.*`。

## 5. 实测数据

### 5.1 框架自测（12/12，
ode test/selftest.cjs`）

覆盖：越界钳制、未知动作拒绝、repeat 钳制、步数上限、非法按键拒绝、真实音量读写、静音往返、条件分支、亮度不支持识别、自定义动作发现与执行、**实验后恢复原状并回读**。

### 5.2 计划生成压测（22 条真实需求，
ode test/plans.test.cjs`）

| 模型 | 通过 | 平均延迟 | 典型错误 |
|---|---|---|---|
| `qwen3.5:2b` | **14/22** | 221ms | "下一首"→`flow.repeat`、"打开微信"→`key.press`、"声音调到最小"→`delta`、拒绝类需求乱凑动作 |
| `qwen3.5:9b` | **22/22** | 1360ms | 无 |

**结论**：默认 9B。2B 不是"差一点"，而是**会用地错误的动作**（把"打开微信"硬凑成按键），这在语音场景里是危险行为。延迟不重要，所以不省这个。

### 5.3 端到端

```
bind "音量调到四十"   → 1269ms 缓存 audio.volume.set(40)
invoke "音量调到四十" → 367ms 执行，实测 volume=0.4
invoke "把窗户打开"   → 正确拒绝（未绑定）
```

## 5.4 所有状态都读真值（不记忆）

| 状态 | 怎么读 | 备注 |
|---|---|---|
| 系统音量 | Core Audio `GetMasterVolumeLevelScalar` | 0..1 标量 |
| 静音 | Core Audio `GetMute` | 写入后需等 60ms 再读 |
| 亮度 | WMI `WmiMonitorBrightness` | 仅内置屏 |
| Handy 是否在录音 | 注册表 `CapabilityAccessManager\...\microphone` 的 LastUsedTimeStart/Stop | 见语音插件 `handy.cjs` |

**意义**：命令之间不需要"记住上一条改了什么"，因此可以任意顺序、重复执行、中断后继续，不会互相污染。

## 5.5 两个踩过的坑

1. **worker 的 stdin 必须锁 UTF-8**：默认按控制台代码页解码，中文参数会变成乱码（`shown` 变 null）。`[Console]::InputEncoding/OutputEncoding` 都要设。
2. **PowerShell 里做字符串替换插入代码要小心反引号**：`` `r
 `` 会被原样写进文件，把两行粘成一行，看起来语法对但变量永远是 null。

## 5.6 媒体控制：切窗口 + 空格（当前实现）

**不用任何音频检测**，直接控制播放器窗口：

```
media.toggle(action=pause|play, app=<窗口正则>)
  1. worker.window.find      在常驻 worker 里枚举窗口（~5ms）
  2. worker.window.activate  切到前台（SetForegroundWindow，40ms 稳定等待）
  3. key.press space         发空格
  4. action=pause → window.restore 把前台还给原窗口；action=play → 留在前台
```

为什么这样：爱奇艺这类自绘客户端不注册系统媒体会话（SMTC 读到 0），UI Automation 也读不到按钮（buttons=0），音频会话枚举拿不到 pid，GPU 计数器读不到显存——试过四条路都不通，最后确定“切前台 + 空格”最可靠。

### 延迟（含 1 秒静音确认）

| 命令 | 起进程→就绪（静音窗内完成） | go→执行完成 | 总 |
|---|---|---|---|
| 发送 | 381ms | **47ms** | 1047ms |
| 声音大一点 / 小一点 | 383ms | **105ms** | ~1105ms |
| 静音 | 365ms | **109ms** | 1109ms |
| 播放爱奇艺 | 388ms | **252ms** | 1252ms |
| 暂停爱奇艺 | 364ms | **252ms + 还原焦点 ~90ms** | 1389ms |

### 预准备（prewarm）机制

听到命令词 → 插件立刻 `spawn node cli pending <词>`：
它先把 node、PowerShell worker、计划加载都做完，输出 `{"ready":true}`，然后**阻塞在读 stdin**。
1 秒静音判定后，插件往它的 stdin 写一行 `go`（或 `abort`）——信号成本≈0，不再起新进程。
8 秒没收到信号会自己退出并释放 worker（防父进程崩溃后残留）。
## 6. 已知限制

1. **按键注入有固有限制**：某些全屏独占程序收不到合成按键；Chromium 对只给扫描码的事件会当 `Unidentified`（所以 worker 里 VK + 扫描码都发）。
2. **亮度**：台式显示器无 `WmiMonitorBrightness`，调用会报"不支持"；笔记本可用。
3. ~~静音状态靠 worker 自己记~~→ 已修：`GetMute` 可用（关键是 vtable 里 channel 那 4 个方法不能省 + `bool` 要显式 `MarshalAs(UnmanagedType.Bool)`）。现在静音是**读真实值**，不再记忆。另注意音频服务异步生效：`SetMute` 后要等 ~60ms 再回读，否则读到旧值。
4. **`ui.toast` 已实现**：右下角 1.6 秒小窗口（`runtime/toast.ps1`，WinForms，独立进程，不写文件）。`invoke` 执行完会自动弹一句结果，例如「音量 90%」。
5. 触发层还没接上：现在要手动 `invoke`，下一步接关键词。

## 7. 下一步

1. 把关键词触发接上：`听我说 → 进入听写 → ASR 出文本 → 查缓存/invoke`（用现有插件，不重写）。
2. ~~`ui.toast` 做成真的浮层~~ → 已实现（`runtime/toast.ps1`）。
3. 计划缓存加"导入/导出"，方便分享。
4. 稳定后考虑移植 Rust 单 exe。
