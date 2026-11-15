# 阈值自学习：架构设计稿

> 状态：**只做设计，未实现**。
> 本文替代上一版 CLI 交互稿的部分内容：交互改为「点一次开始录、再点一次结束」，由说话人决定一句话结束，不由检测决定。

---

## 1. 一句话架构

**两个互不相干的生产者，各自往触发层交东西：**

```
                 ┌─────────────────────────┐
   AI 生成计划 →  │ planner   （计划生产者） │ → plans.json ─┐
                 └─────────────────────────┘              │
                                                          ├→ 触发层（KWS + 1 秒静音）→ 执行
                 ┌─────────────────────────┐              │
  录音 + 扫阈值 → │ calibrator（阈值生产者） │ → thresholds.json ─┘
                 └─────────────────────────┘
```

- **planner**：`src/ai.js` + `src/core.js`，输入一句中文，输出可执行计划。
- **calibrator**：新增，输入若干段录音，输出每个词的阈值。
- 两者**没有代码依赖**：calibrator 不 require planner，planner 不 require calibrator。
- 唯一的耦合点是**磁盘上的两个 JSON**，以及 `kws.cjs` 读阈值时"文件不存在就回落默认值"。

这也回答你的问题：calibrator 只输出一个数，给唤醒/触发那一侧用，完全解耦。

---

## 2. 模块边界

```
voice-plugin/                     ← 触发层所在项目
  runtime/listener/kws.cjs        ← 读阈值（3 级回落）
  runtime/listener/main.cjs       ← 录音时暂停/恢复监听
  runtime/daemon/server.cjs       ← 新增 /calibrate/* 路由
  runtime/calibrator.cjs          ← 新增：录音管理 + 扫阈值 + 落盘

voicekeys/                        ← 计划层所在项目（本目录）
  src/core.js                     （不动）
  src/ai.js                       （不动）
  src/store.js                    （不动）
```

**为什么 calibrator 放插件侧而不是 voicekeys 侧**：
1. 麦克风在插件手里（listener 已经打开了设备）；
2. 阈值只影响 KWS，KWS 在插件里；
3. 放 voicekeys 就得把音频设备、KWS 模型路径都复制一份，反而增加耦合。

calibrator 内部只需要：一段 WAV → 一个阈值。它通过 `require('./listener/kws.cjs')` 复用现成的 `keywordLines` / `buildSpotter`，**不新写解码逻辑**。

---

## 3. 录音的独占问题（必须先解决）

插件当前常驻监听麦克风。录音和监听**不能同时抢同一设备**（两个 pvrecorder 会互相拖缓冲）。

所以录音流程必须是：

```
POST /calibrate/start
  → listener.pause()        停止 KWS 解码、释放设备
  → 新开一个 recorder       16kHz/mono，写入 calib/tmp-<ts>.wav
  → 返回 {recording:true, startedAt}

POST /calibrate/stop
  → recorder.stop()         关闭文件
  → listener.resume()       恢复监听
  → calibrator.addWav(file) 计算阈值
  → 返回 {recording:false, count, threshold, floors}
```

`listener.pause()/resume()` 是**已存在**的能力（之前为 `/pause` 路由写过），直接复用。

失败兜底：如果 `stop` 没被调用（浏览器关了、页面崩了），daemon 侧加一个 **90 秒硬超时**自动 stop，避免麦克风一直被占。

---

## 4. 交互与状态机（按你的描述）

按钮语义：**点一次 = 开始录，再点一次 = 结束这段**。

```
状态: idle(0/5) --click--> recording --click--> idle(1/5, threshold 已更新)
                                          ...
  第 6 段录完 → 环形缓冲踢掉最早那段 → idle(5/5)
```

UI 需要显示的东西（就是你说的那几样）：

| 元素 | 说明 |
|---|---|
| `3 / 5` 计数 | 当前保存了几段 |
| **录音**按钮 | 空闲时=开始录；录音中=结束这段（按钮文字/颜色切换） |
| **清空**按钮 | 删除该词全部录音 + 删掉 thresholds.json 里该词的条目 |
| **当前阈值** | `0.09（自动，5 段样本）` 或 `0.12（手动）` |
| 模式选择 | `手动 / 自动` 两选一；选自动后录音相关控件才出现 |

**上限 5 段、环形覆盖**：第 6 段写入时删掉最旧的一段，用文件 mtime 排序，不维护额外索引。

---

## 5. HTTP 接口（挂在现有 daemon 19510 上）

| 方法 | 路径 | 作用 | 返回 |
|---|---|---|---|
| POST | `/calibrate/start` | 暂停监听、开始录音 | `{recording:true}` |
| POST | `/calibrate/stop` | 结束录音、重算阈值、恢复监听 | `{count, threshold, floors:[…], dropped?}` |
| GET | `/calibrate/state?word=` | 查当前状态 | `{mode, count, max:5, threshold, floors, durationMs}` |
| POST | `/calibrate/clear` | 清空该词录音与阈值 | `{count:0}` |

所有路由都接受 `?word=<词>`，因为阈值是**按词**的。

**不加鉴权**：只监听 127.0.0.1，且不改变系统状态（只写 `%LOCALAPPDATA%`）。

---

## 6. 存储布局

```
%LOCALAPPDATA%\dsh-voice\calib\
  声音大一点\
    20261114-2230-01.wav
    20261114-2231-15.wav
    ...                    ← 最多 5 个，按 mtime 环形覆盖
  thresholds.json          ← 全局一份，按词组织
```

```json
{
  "model": "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20",
  "modelFingerprint": "encoder.onnx@37219518,tokens.txt@sha1:ab12…",
  "mode": "auto",
  "words": {
    "声音大一点": { "threshold": 0.09, "floors": [0.11,0.10,0.11,0.09,0.10], "samples": 5, "updatedAt": "…" },
    "静音":      { "threshold": 0.06, "floors": [0.08,0.07,0.08,0.06,0.07], "samples": 5, "updatedAt": "…" }
  }
}
```

**模型指纹**：换模型后指纹不匹配 → 整个文件作废（忽略并按默认阈值跑），避免"换了模型阈值全错还没人发现"。

---

## 7. 阈值计算（每录一段就重算）

```
addWav(file):
    floor = 二分扫阈值，找"能命中的最低阈值"（0.06..0.30，步长 0.01）
    该词的 floors 追加 floor（环形，只留最近 5 个）
    worst = max(floors)
    threshold = clamp(worst - 0.02, 0.06, 0.30)
    写 thresholds.json（原子写：临时文件 + rename）
    kws.reload()          ← 让新阈值立刻生效，不用重启 daemon
```

- **每段都重算**（按你的要求），所以录到一半就能看到阈值变化。
- 只有 1 段样本时也给结果，但 UI 标注"样本不足（1/5），建议继续录"。
- 少于 1 段 → 不写文件。

---

## 8. 与触发层的集成（auto 模式）

`kws.cjs` 的 `keywordLines(words, tokensFile, threshold)` 已有"按词阈值"能力（`thresholdFor`）。改动只有一处：

```js
// 现在：threshold 来自 settings.keywordThresholds（0.2 / 0.15 / 0.12）
// 将来：先查 thresholds.json，命中就用它，否则回落
const thresholds = calibrator.thresholdsFor(words);   // { word: 0.09, ... }
```

优先级：**thresholds.json → 环境变量 → 默认值**。文件不存在时静默回落，不报错。

**auto / manual 的区别只在这一点**：
- `manual`：忽略 thresholds.json，用配置值（现在 0.12）。
- `auto`：用 thresholds.json；某词没有记录 → 回落配置值。

---

## 9. UI 落在哪里（两种，需要你选）

| 方案 | 做法 | 成本 | 代价 |
|---|---|---|---|
| **A. 独立本地页**（推荐） | daemon 多一个路由 `/calibrate`，返回一个自包含 HTML（原生 JS，无构建） | 半天 | 不在 DSH 插件设置里，要单独开一个页面 |
| **B. 嵌进 DSH 插件设置面板** | 恢复 `dsh.client` + React 面板，通过 RPC 调宿主 → 宿主转发到 daemon | 1.5–2 天 | 需要构建链（tsup/esbuild）、插件要重新打包、版本要跟着 DSH 走 |

推荐 **A**：你要的"点按钮录音"本质是一个本地控制面板，用 HTML 就够；B 的唯一优势是"在同一处设置里"，但代价是整个插件重新引入前端构建。

如果选 A，UI 可以直接复用刚才设计的状态机，页面只有三个按钮 + 两个数字，约 120 行 HTML/JS。

---

## 10. 失败模式

| 场景 | 处理 |
|---|---|
| 录音时浏览器/页面崩了 | daemon 90 秒硬超时自动 stop |
| 录音太轻（RMS 低于阈值） | 该段丢弃并提示"太轻，重录"，不进入 floors |
| 5 段极差 > 0.06 | 结果照算，但 UI 标注"你的发音波动较大，建议再录" |
| 词不在词表里 | 拒绝：404 + 提示"先把词加到命令词列表" |
| 模型被换掉 | 指纹不匹配 → 忽略 thresholds.json，UI 标"需要重测" |
| 清空 | 删目录 + 删该词条目；插件立即回落到配置阈值 |

---

## 11. 工作量分解

| 阶段 | 内容 | 预估 |
|---|---|---|
| M1 | `calibrator.cjs`：录音开关 + 扫阈值 + 落盘（无 UI，用 curl 测） | 45 分钟 |
| M2 | daemon 路由 + listener 暂停/恢复联动 | 30 分钟 |
| M3 | 自包含 HTML 页（计数、录音、清空、阈值显示） | 60 分钟 |
| M4 | auto 模式接入 `kws.cjs` + 实时 reload | 30 分钟 |
| **合计** | | **约 3 小时** |

---

## 12. 验证实验（M4 完成后）

> **预期**：录 3 段后阈值下降；说该词 3 次全部命中；点"清空"后阈值回落 0.12，说该词命中率下降但不再误触。
> **最小验证**：录一段 → 看 `thresholds.json` 的 floors 与 threshold；再喊该词一次，日志出现 `keyword=<词>`。
> **对照**：把 mode 切回 manual（0.12）再说 3 次，比较命中次数。
> **回滚**：删 `calib/` 目录 + 把 mode 设 manual，即完全回到现在的行为。
