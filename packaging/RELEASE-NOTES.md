## VoiceKeys v0.2.0 — Windows x64 安装版

**下载 `VoiceKeys-Setup-0.2.0.zip` → 解压 → 双击 `VoiceKeys-Setup-0.2.0.exe` → 装完点「是」启动。**

也可以直接下 `VoiceKeys-Setup-0.2.0.exe`（单文件安装器）。

### 这一版修了什么

上一版双击 `VoiceKeys.exe` 之后，程序会在夜里自己消失（日志最后一条是麦克风读取失败），
而且没有任何机制把它拉起来 —— 所以第二天喊话"没反应"。这一版：

- **`VoiceKeys.exe` 变成守护进程**：node 退出后按退避（1s→2s→…→30s）自动重启，
  每次重启写进 `logs\supervisor.log`
- **未捕获异常会记录**（以前进程直接死、日志里什么都没有）
- **音频连续读取失败 20 次会自动重建音频源**（麦克风被别的程序抢走/设备掉线）
- 首次运行前不用再手动解压一堆文件，安装器会建开始菜单快捷方式、桌面快捷方式、卸载入口

### 装在哪里（不需要管理员权限）

```
程序：%LOCALAPPDATA%\Programs\VoiceKeys
数据：%LOCALAPPDATA%\VoiceKeys
      （关键词、设置、录音素材、日志、模型都在这里；卸载默认保留）
```

所有东西都在用户目录，双击不会弹 UAC。

### 第一次运行

1. 自动建数据目录，并放 8 个示例关键词
2. 顶部提示**还没有语音模型**，两个选择：
   - 「我本地有，指定目录」
   - 「没有，帮我下载（约 155MB）」
3. 下完点重启（或重新打开应用）

### 系统要求

- Windows 10/11 x64（包内自带 Node 运行时，不需要装 Node）
- 麦克风
- 可选：[Handy](https://github.com/cjpais/Handy)（「听我说 / 我说完了」用）

### 怎么停 / 怎么卸载

- 停：开始菜单 → VoiceKeys → 「停止 VoiceKeys」（或安装目录里的 `stop.cmd`）
- 卸载：设置 → 应用 → VoiceKeys（或开始菜单里的卸载项）

### 开机自启

把开始菜单里的 VoiceKeys 快捷方式拖进 `shell:startup`（Win+R 输入 `shell:startup`）。

### 校验

SHA256 见 `SHA256.txt`。
