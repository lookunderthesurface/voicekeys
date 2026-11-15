## VoiceKeys v0.1.0 — Windows x64（免装 Node）

下载 `VoiceKeys-win-x64.zip` → 解压 → 双击 **VoiceKeys.exe**。浏览器会自动打开 `http://127.0.0.1:19600/`。

### 第一次运行会做什么

1. 在 `%LOCALAPPDATA%\VoiceKeys\` 建好用户目录（设置、绑定表、录音素材、日志都在这里）
2. 自动播种 8 个示例关键词，装好就能试
3. 顶部提示**还没有语音模型**，两个选择：
   - 「我本地有，指定目录」→ 贴模型所在路径（需要 M1 的 `encoder-*.int8.onnx` 或 M2 的 `model.int8.onnx`）
   - 「没有，帮我下载（约 155MB）」→ 自动从 k2-fsa 官方 release 下载并解压

### 系统要求

- Windows 10/11 x64
- 麦克风（不支持 ARM64；包内已带 Node 运行时，不需要额外安装）
- 可选：[Handy](https://github.com/cjpais/Handy) 语音听写（「听我说 / 我说完了」用）

### 装机内容（约 120MB 解压后）

| 组件 | 说明 |
|---|---|
| `VoiceKeys.exe` | 启动器（无黑框，起服务并开浏览器） |
| `runtime/node.exe` | Node 24 运行时 |
| `lib/` | sherpa-onnx（M1/M2 识别）+ pvrecorder（录音）+ pinyin-pro |
| `app/algorithms/` | 三个可替换算法的默认实现（明文 .js，界面里可备份并编辑） |

模型不进包（体积 + 许可），首次运行按需下载。

### 已知限制

- 媒体控制（播放/暂停视频）靠"激活播放器窗口 + 按空格"；如果 Windows 拒绝前台切换，会**放弃按键并写日志**，绝不会把按键打到别的窗口
- 校准（Calibrator）是实验功能，默认关闭
- 只支持 Windows

### 校验

```
SHA256 见下方 Release 说明中的 SHA256.txt
```
