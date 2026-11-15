# VoiceKeys 设计文档 v0.2

> 独立的 Windows 小工具：**听到某个词 → 按一下键**。
> 与 DSH 无关，与任何聊天/笔记/游戏软件无关，是系统级输入增强工具。

- 版本：v0.2（研究后修订）
- 日期：2026-11-14
- 状态：待评审
- v0.1 → v0.2 的改动全部来自读源码，见第 3 节

---

## 1. 一句话定位

**离线、常驻、极轻的「语音 → 按键」触发器。**
说一个词，它按一下键（或打一段字、跑一条命令）。

差异化不是"能听词"，而是**抗误触**：只有「词前安静 → 词 → 词后安静」三段都成立才触发。
市面上（VoiceAttack / VoiceMacro / Porcupine 示例）都只做第一层。

## 2. 研究过程（v0.2 的依据）

| 做了什么 | 得到什么 |
|---|---|
| 克隆 `cjpais/Handy`（MIT，38.7k★，8.3 MB）| 看它**怎么做按键注入、怎么采音、怎么用 VAD**。这是同场景最成熟的开源实现（81 个 Rust 文件 / 33.7k 行） |
| 克隆 `thewh1teagle/sherpa-rs`（MIT，314★）| 确认 **KeywordSpot / SileroVad 的现成封装**，不必自己写 FFI |
| 读 `sherpa-onnx` 官方 Rust 示例 | 确认 KWS 的标准用法 |
| 查 crates.io 下载量 | 每个依赖的成熟度都有数（见第 3 节表） |
| 查许可 | sherpa-onnx **Apache-2.0**、sherpa-rs **MIT**、Handy **MIT** → 都能商用/闭源 |

**结论：v0.1 的技术栈方向对，但有四处需要改**（VAD、注入库、绑定库、采样处理），见下。

## 3. 技术栈（v0.2，逐项有据）

| 层 | 选型 | 证据 |
|---|---|---|
| 语言 | **Rust**（2021 edition） | 单 exe、无运行时；Handy 同语言同场景已验证 |
| 采集 | **cpal 0.18**（28.7M 下载） | 跨平台、WASAPI 共享模式；不依赖年轻 crate |
| 重采样 | **rubato 5.1**（15.5M 下载） | Handy 的选择（`rubato = "5"`，见其 `Cargo.toml`）；48k→16k |
| 唤醒词 | **sherpa-rs 0.6.8**（MIT，105k 下载）里的 `KeywordSpot` | 见下"接口实测" |
| 静音判定 | **Silero VAD**（sherpa-rs 的 `SileroVad`） | Handy 默认 `vad_backend: silero`；比振幅阈值抗噪 |
| 按键 | **enigo 0.6.1**（4.1M 下载） | **Handy 生产环境就用它**（`enigo = "0.6.1"`） |
| 托盘 | **tray-icon 0.26**（43.7M 下载） | Tauri 同款底层 |
| 设置界面 | **eframe/egui 0.37**（24.8M 下载） | 无 WebView，+3 MB；比 Tauri 省 60 MB 和 WebView2 依赖 |
| 开机自启 | **auto-launch 0.6**（8M 下载） | 写 HKCU Run，无需管理员 |
| 全局热键 | **global-hotkey 0.10**（7.7M 下载） | 备用：按住说话 / 暂停监听的应急键 |
| 配置 | serde + serde_json | 人可读、可分享 |
| 日志 | tracing + tracing-appender | 滚动文件 |
| 单实例 | `windows` crate 命名互斥体 | 双击第二次唤出设置 |

### 3.1 唤醒词接口：sherpa-rs 实测

读 `sherpa-rs/crates/sherpa-rs/src/keyword_spot.rs`：

```rust
pub struct KeywordSpotConfig {
    pub zipformer_encoder: String,   // 三个 onnx
    pub zipformer_decoder: String,
    pub zipformer_joiner: String,
    pub tokens: String,              // tokens.txt
    pub keywords: String,            // 关键词文件路径
    pub max_active_path: i32,        // 我们设 4
    pub keywords_threshold: f32,     // 每词阈值
    pub keywords_score: f32,         // 关键词加权
    pub num_trailing_blanks: i32,    // 我们设 1（越低越灵敏、越快）
    pub sample_rate: i32,            // 16000
    pub feature_dim: i32,            // 80
    pub num_threads: Option<i32>,    // 1（避免吃满 CPU）
    pub provider: Option<String>,    // "cpu"
}
```

`extract_keyword(samples) -> Option<String>` 是流式的，正好适配"每 100ms 喂一块"。
**限制**：它把 `keywords` 当**文件路径**传（`keywords_file`），C API 其实也支持 `keywords_buf` 内存字符串。
→ 我们的做法：启动时写一个临时关键词文件（Node 原型已验证可行）；顺手给 sherpa-rs 提个 PR 支持 `keywords_buf`（可选）。

### 3.2 按键注入：为什么必须 VK + 扫描码（重要）

我在 Node 原型里踩过这个坑：用 PowerShell 的 `SendKeys` 和"只有扫描码"的 `SendInput` 往 DSH（Electron）里注入回车，**字母能进去，回车进不去**。
读 enigo 的 Windows 实现（`src/win/win_impl.rs`）才明白：

```
wVk: vk,                        // ← 同时给虚拟键码
wScan: scan,
let vk = MapVirtualKeyExW(scan, MAPVK_VSC_TO_VK_EX);   // 扫描码 ↔ 虚拟键互转
KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP
if let Key::Unicode(c) = key { /* KEYEVENTF_UNICODE，直接打字符 */ }
```

**只给扫描码、`wVk=0` 的事件，Chromium 会解析成 `key="Unidentified"`，于是被忽略。**
enigo 两个都给，所以 Handy 的 Ctrl+V 能进 DSH，而我的实验进不去。
→ 结论：**按键层用 enigo，不自己写 SendInput**。这也是 v0.1 需要改的地方。

### 3.3 静音判定：用 Silero VAD，不用简单振幅阈值

读 `sherpa-rs/crates/sherpa-rs/src/silero_vad.rs`：

```rust
pub struct SileroVadConfig {
    pub threshold: f32,             // 默认 0.5
    pub min_silence_duration: f32,  // 默认 0.5s
    pub window_size: i32,           // 默认 512
}
```

VAD 给的是"这段是不是人声"的概率，而不是音量大小。好处：

- 背景音乐/风扇/键盘声不会被当成"还在说话"
- 轻声说话也不会被当成静音
- Handy 生产环境就用 silero（设置里 `vad_backend: silero`），说明这条路稳

→ 我们的静音门用 **VAD 概率 + 能量** 双条件；能量只做快速预筛（省 CPU）。

## 4. 架构

```
┌──────────────────────────────────────────────────────────────┐
│ VoiceKeys.exe                                                │
│                                                              │
│  cpal 采集(48k/2ch) → 降混+rubato 重采样(16k/f32) → 100ms块   │
│        │                                                     │
│        ├──────────────► KWS(spotter)  ──命中(word,t,score)──┐ │
│        │                                                     │ │
│        └──────────────► VAD + 能量 → 每块语音概率 ──┐         │ │
│                                                    ▼         ▼ │
│                                     ┌──────────────────────────┐
│                                     │ gate：三段式确认          │ │
│                                     │  首部门 + 尾部确认窗      │ │
│                                     │  + 冷却 + 互斥 + 噪声自适应│ │
│                                     └──────────┬───────────────┘ │
│                                                ▼                │
│                                     ┌──────────────────────────┐│
│                                     │ action：键/组合键/文本/命令││
│                                     └──────────┬───────────────┘│
│                    托盘状态 / 提示音 ◄──────────┘                │
└──────────────────────────────────────────────────────────────┘
```

线程：`audio`（采集+重采样）→ `kws`（解码）→ `gate+action`（判定与执行）；用有界 channel 串。
KWS 与 VAD 各吃一份同样的音频块（VAD 很便宜，不额外占麦）。

## 5. 核心算法：三段式确认

```
        leadMs(默认300)     命中            graceMs(250)   gateMs(每词可配,默认1000)
   ────────────────┬──────────────┬─────────────────────┬──────────────►
                   │              │                     │
              首部要求安静      词尾            确认窗：VAD 概率必须持续低
```

判定：

1. **首部门**：命中前 `leadMs` 内 VAD 概率均值 < `leadThreshold`（默认 0.35）。
   → 排除"说话途中恰好含一个词"。
2. **命中**：KWS 报 keyword（附 acoustic score，可要求 > `minScore` 二次过滤）。
3. **尾部确认窗**：从命中起跳过 `graceMs`，之后 `gateMs` 内每一块都要"非人声"：
   - 任一块 VAD > `gateThreshold`（默认 0.4）→ **丢弃**，日志记 `dropped(kept talking)`
   - 全部通过 → 执行
4. **冷却**：同词 `cooldownMs`（默认 3000）内不重复。
5. **互斥**：任一次执行后 `globalCooldownMs`（默认 1000）内忽略其它词。
6. **噪声自适应**：滑动估计底噪，动态抬升 `gateThreshold` 的等效门槛，避免嘈杂环境连触发。

**每个词独立配置**：唤醒词 `gateMs=0`（说完立刻响应），结束词 `gateMs=1000`（防句中同形词）。

## 6. 功能清单

### v1（自用可用）
- 多关键词（默认 3，最多 16）
- 词编码：中文→拼音、英文→模型自带 `en.phone` 音素（Node 原型已验证 `over → OW1 V ER0`）
- 动作：单键 / 组合键 / 文本 / 命令 / URL
- 三段式确认（每词独立）+ 冷却 + 互斥 + 自适应
- 托盘：状态、暂停监听、打开设置、退出
- 设置窗口（egui）：词表、动作编辑、麦克风、实时电平+**VAD 概率**、试听模式（只听不执行）
- JSON 配置（可导入导出）、滚动日志、单实例、可选自启

### v2（可发布）
- 词包（中文/游戏/编程/直播）
- 按前台应用生效（`GetForegroundWindow` + 进程名匹配）
- 提示音（开始/触发/丢弃）+ 音量
- 模型管理（内置 + 可换目录 + 下载器）
- 首次向导：选麦 → 说一句 → 看命中与分数 → 一键保存
- 自动更新检查（GitHub Releases）
- 发布：zip 免安装 + winget 清单（后期代码签名）

### 明确不做
- 不做转写/听写（要听写就发按键给 Handy 之类）
- 不联网、不做账号、不上传音频
- 不做大模型

## 7. 目录结构

```
voicekeys/
├─ Cargo.toml
├─ src/
│  ├─ main.rs         启动、单实例、托盘事件循环
│  ├─ config.rs       配置结构/读写/校验
│  ├─ keywords.rs     词编码（拼音 / en.phone）
│  ├─ audio.rs        cpal 采集 + 降混 + rubato 重采样
│  ├─ kws.rs          sherpa-rs KeywordSpot 封装
│  ├─ vad.rs          Silero VAD 封装（含能量预筛）
│  ├─ gate.rs         三段式确认/冷却/互斥（纯逻辑，可单测）
│  ├─ action.rs       enigo 按键 / 文本 / 命令 / URL
│  ├─ tray.rs         tray-icon + 菜单
│  ├─ settings.rs     egui 设置窗口
│  └─ log.rs          tracing
├─ models/            默认 KWS 模型（37 MB）
├─ docs/{DESIGN.md,TESTPLAN.md}
└─ README.md
```

预估代码量 **2-3k 行**（Handy 33.7k 行是完整听写产品，我们只做触发器）。

## 8. 性能预算

| 指标 | 目标 | 依据 |
|---|---|---|
| 空闲 CPU | < 2%（单核） | Node 原型实测 ~1% |
| 常驻内存 | < 120 MB | Node 版 123 MB；Rust + sherpa-rs 应更低 |
| exe 体积 | 10-15 MB（+ DLL 10 MB + 模型 37 MB） | sherpa-onnx DLL 固定 |
| 唤醒延迟 | 词尾→动作 < 300 ms（gate=0） | Node 实测 200-400 ms |
| 冷启动 | < 1.5 s | 模型加载 300-800 ms |

## 9. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| **M0 技术验证（先做，防返工）** | ① `cargo build` 拉通 sherpa-rs（download-binaries）② enigo 往 DSH/记事本/浏览器/VS Code 注入 Enter 与 Ctrl+Space ③ 实测 KWS+SileroVAD 的 CPU/内存 ④ 48k→16k 重采样音质 | 半天 |
| M1 | 采集→KWS→gate→单键；托盘+配置+日志；命令行可用 | 1 天 |
| M2 | 设置窗口、多词多动作、试听、单实例、自启、zip 发布 | 2 天 |
| M3 | 词包、按应用生效、提示音、向导、更新、winget | 2 天 |

M0 的四个验证结果会直接决定 M1 是否要换方案（例如 enigo 注入不理想 → 改剪贴板粘贴为主路径）。

## 10. 风险（v0.2 更新）

| 风险 | 影响 | 对策 |
|---|---|---|
| ~~按键注入进不了 Electron~~ | ~~功能失效~~ | **已定位**：必须 VK+扫描码，用 enigo。M0 再实测 DSH/浏览器/VS Code 三类目标 |
| sherpa-rs 的 `keywords` 只收文件路径 | 小瑕疵 | 写临时文件；可选给上游提 PR 支持 `keywords_buf` |
| sherpa-rs 构建依赖预编译库下载 | 首次编译可能慢/失败 | `download-binaries` feature；失败则手动放置 DLL |
| 未签名 exe 被杀软误报（常驻+模拟按键） | 分发受阻 | 先 zip + README；后续代码签名（约 ¥1000-2000/年） |
| 与 Handy/其它录音软件共享麦克风 | 采不到音 | WASAPI 共享模式；Handy 同场景已验证；M0 实测双开 |
| 词编码依赖模型词表 | 换模型要重编码 | 编码器按 tokens.txt 动态生成（Node 版已有实现） |
| 中文外的语种 | 局限 | 模型自带 30+ 语言音素表，按词包扩展 |

## 11. 与参考项目的关系（合规）

- **Handy（MIT）**：只借鉴思路与工程取舍（enigo 注入、silero VAD、rubato 重采样），**不复制其代码**；如需复用片段会在文件头注明来源与许可。
- **sherpa-rs（MIT）/ sherpa-onnx（Apache-2.0）**：作为依赖库使用，保留 LICENSE 与 NOTICE。
- 模型：k2-fsa 发布的 KWS 模型（Apache-2.0），随包分发时带 LICENSE。

## 12. 待评审的决策点

1. 技术栈：**Rust + egui**（推荐）还是 Tauri（前端好看但 +60 MB）？
2. 界面：设置窗口（egui）还是先只做 JSON + 托盘？
3. 模型分发：外置 `models/`（可换）还是内嵌（单文件更大）？
4. 首发范围：仅 Windows，还是同时留 Linux/macOS（cpal/enigo 都跨平台，成本低）？
5. 名字：`VoiceKeys` / `VoiceTrigger` / 中文名？

## 13. 验收标准（发布前）

- 真实麦克风、静音门开启：句中含关键词 **10 次不误触发**；词后停顿 **10/10 触发**。
- 连续 24 小时：内存漂移 < 5%，无丢音、无卡死。
- 与 Handy 同时运行互不干扰。
- 按键能进 记事本 / 浏览器 / VS Code / DSH 四类目标（VK+扫描码路径）。
- 冷启动 < 1.5 s，空闲 CPU < 2%。
