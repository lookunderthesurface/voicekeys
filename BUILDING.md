# 构建与运行

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 x64 | 依赖 Win32 窗口/按键/Core Audio API |
| Node.js | **>= 22** | transcribe-cpp 的 engines 要求 |
| pnpm | 任意近期版本 | 也可以用 npm |
| 麦克风 | 任意可用设备 | 程序会自动挑"真的会出数据"的那个 |

**不需要**：CUDA、Python、CMake、Visual Studio（见下面的例外）。

## 只改 JS / 改规则（最常见的魔改）

```powershell
git clone <repo> voicekeys
cd voicekeys
pnpm install          # 会装上 sherpa-onnx-node、pvrecorder、transcribe-cpp 的预编译二进制
node app/server.js --port 19600 --open
```

改 `app/matcher.js`、`app/trigger.js`、`app/ui.html` 之后**直接重启进程**即可，不需要任何编译步骤。

## 模型

| 模型 | 用途 | 大小 | 获取方式 |
|---|---|---|---|
| `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23` | 触发层识别 | 24 MB（int8） | 首次启动自动下载，或手动放到 `%LOCALAPPDATA%\dsh-voice\models\asr\` |
| `Qwen3-ASR-0.6B-Q8_0.gguf` | 校准时的"老师" | 811 MB | 第一次点「复核」时按需加载；若本机已装 Handy，会直接复用它的 HuggingFace 缓存 |

模型**不随仓库分发**。离线环境请自行下载后放到上述目录，或用环境变量覆盖：

```powershell
$env:VK_ASR_DIR       = "D:\models\zh-14m"          # 触发层模型
$env:VK_TEACHER_MODEL = "D:\models\Qwen3-ASR-0.6B-Q8_0.gguf"  # 老师模型
```

## 打包成 exe

```powershell
pnpm release -- -Version 0.1.0     # 产出 dist\VoiceKeys-0.1.0-win-x64.zip + .sha256 + 发布说明
```

目前是**免安装目录形式**（zip 里是 `start.cmd` + `app/` + `node_modules`），把 `VoiceKeys.exe` 打成单文件还在 `DESIGN-packaging.md` 里做技术选型。

打包后的 zip 里包含：
- `VoiceKeys.exe`（Node SEA 或等价方案；见 `DESIGN-packaging.md`）
- `node_modules` 中所有原生 `.node` 二进制（sherpa-onnx、pvrecorder、transcribe-cpp、koffi）
- `app/ui.html` 等静态资源

**模型不进 zip**，仍是运行时下载。

## 什么时候才需要编译器

只有一种情况：你要**重新编译原生模块**（例如升级 sherpa-onnx 版本、改 C++ 层）。

那时需要：
1. Visual Studio 2022 Build Tools（含 C++ 工作负载）
2. CMake 3.20+
3. `npm rebuild sherpa-onnx-node` 或在对应包目录里 `cargo build`（transcribe-cpp 的 Rust 绑定）

普通使用者与"改规则"的开发者**完全不需要**这一步。

## 常见问题

**Q: 启动后没反应？**
看 `%LOCALAPPDATA%\dsh-voice\app.log`。最常见的是麦克风选错设备——日志里会打印每个设备的 `peak`，全 0 的是死设备。

**Q: 识别不准？**
先看界面右上角的「我们的转写」。如果转写本身就不对，是模型问题；如果转写对了但没触发，是匹配规则问题。用「复核」跑一遍，报表会直接告诉你属于哪一类。

**Q: 想换成英文唤醒词？**
换一个支持英文的 ASR 模型（`VK_ASR_DIR` 指过去），然后把关键词改成英文即可——词表就是普通字符串。

**Q: 改坏了怎么办？**
界面上「快照与恢复」→ 选一个之前的版本 → 恢复。恢复前的改动会进 `git stash`，不会丢。
