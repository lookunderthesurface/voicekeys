## VoiceKeys v0.2.1 — Windows x64

**只下一个文件：`VoiceKeys-Setup-0.2.1.exe`**（45.5MB），双击安装。不需要解压 zip。

### 这一版改了什么

| 改动 | 说明 |
|---|---|
| **接上 M2 预热** | 之前 `confirmer.preload()` 写好了却从没被调用，日志永远是"未预热"。现在麦克风一检测到人声就预热，第一次唤醒不再多等约 300ms（模型冷加载 800ms） |
| **卸载器瘦身** | 安装体积 **166MB → 120.6MB**。之前 `uninstall.exe` 是 setup.exe 的副本（45MB 重复），现在是一个 7KB 的小卸载器 |
| **不再出 zip** | 只需要 setup.exe，压缩包是多余的 |

### 装在哪里

```
程序：%LOCALAPPDATA%\Programs\VoiceKeys          120.6MB
数据：%LOCALAPPDATA\VoiceKeys                    模型/词表/设置/录音/日志
开始菜单：%APPDATA%\Microsoft\Windows\Start Menu\Programs\VoiceKeys\
桌面：VoiceKeys.lnk
注册表：HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceKeys
```

全部在用户目录，**不需要管理员权限、不弹 UAC**。

### 卸载时

**会删**：程序目录、开始菜单项、桌面快捷方式、注册表卸载项（+ 可能存在的开机自启项）

**不会删**：数据目录 `%LOCALAPPDATA%\VoiceKeys`（模型 157MB、你的 17 个关键词、设置、录音素材）

想彻底清空，卸载后手动删掉数据目录即可。

### 系统要求

- Windows 10/11 x64（自带 Node 运行时，不需要装 Node）
- 麦克风
- 可选：[Handy](https://github.com/cjpais/Handy)（「听我说 / 我说完了」用）

### 校验

SHA256 见 `SHA256.txt`。
