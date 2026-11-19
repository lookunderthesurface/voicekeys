# 打包说明（给上架用）

## 一、用户可改的算法会不会被编译进去

**不会，也不需要把编译工具链打进包里。**

- **JS 是解释执行的**：不管打成 exe 还是 zip，里面装的都是同一个 V8 引擎 + 你的 JS；
  运行时才把它编译成机器码，这一步**不需要 Node 源码、不需要 C++ 工具链、不需要 npm**。
- 我们的算法文件按"外部文件"加载：`app/algorithms/index.js` 用
  `fs.readFileSync` + `vm.compileFunction` 读 `.js`，**不走 `require`**，
  所以打包器的快照文件系统拦不到它。
- 真正必须外置的是**原生模块**（`.node`），它们本来就是二进制。

| 问题 | 答案 |
|---|---|
| 用户可改的算法要不要编译 | 不要，保持 `.js` 明文 |
| 包里需要带编译环境吗 | 不需要，V8 内置在运行时里 |
| 包里必须外置什么 | 原生 `.node`、模型、用户数据 |

## 二、目录结构（便携目录 + 启动器）

```
VoiceKeys/
  VoiceKeys.exe          ← 启动器（拉起 node.exe app/server.js，然后打开浏览器）
  node.exe               ← 官方 Node 运行时
  app/                   ← 我们的代码（.js 明文）
    config.js            ← 用户数据目录解析（首次运行建目录）
    algorithms/*.default.js   ← 算法原始实现（在包里，用户默认看不到）
    ui.html
    ...
  lib/                   ← 运行时依赖（已经从 voice-plugin 复制过来）
    runtime/listener/{audio,config,protocol,handy}.cjs   ← 纯 JS
    node_modules/sherpa-onnx-node/         ← ASR 引擎
    node_modules/sherpa-onnx-win-x64/      ← 引擎原生库（22MB）
    node_modules/@picovoice/pvrecorder-node/ ← 麦克风（8.6MB）
  models/                ← 空目录，首次运行按需下载（不进包）
```

`app/paths.js` 的解析顺序：

```
VOICEKEYS_VENDOR  →  app/lib（随包发布）  →  tools/voice-plugin（仅开发机兜底）
```

> 2026-11-16 起依赖已复制进 `lib/`，**VoiceKeys 不再需要 DSH 插件目录**；
> `lib/` 被 `.gitignore` 忽略（可重建），发版时用 `scripts/bootstrap-lib.cjs` 生成。

## 三、用户数据目录（首次运行自动创建）

`%LOCALAPPDATA%\VoiceKeys\`

```
config.json          生成的说明（给人看：哪个文件是干什么的）
settings.json        界面设置（模型来源、阈值、采集上限…）
plans.json           关键词 → 计划（可以让你的 agent 直接往这里写）
algorithms/          用户改过的算法（点"备份并开始编辑"才出现）
algorithms/.backup/  每次开始编辑前的快照
capture/             校准素材（录音 + index.jsonl + suggestions.json）
models/              模型（首次运行按需下载）
logs/app.log         日志
```

**卸载只删安装目录时用户数据还在；覆盖升级不会丢配置。**
删掉整个 `VoiceKeys` 目录 = 恢复出厂设置。

## 四、算法文件随程序发布（默认不可见）

安装包里**没有可编辑的散文件**。用户点「① 备份并开始编辑」时才：

1. 把 `app/algorithms/*.default.js` 展开成 `algorithms/user/<role>.js`（三个角色各一份）；
2. 让 `settings.algorithms` 指向这些副本；
3. 立刻做一份快照（`algorithms/.backup/<时间戳>/`）。

改坏了点「② 一键还原全部」回到快照。

## 五、Calibrator 的定位（必须写进安装说明）

> **校准是实验功能，默认关闭。**
> 面板默认收起，只有勾选"展开"才显示；打开后它用本地 0.6B 老师模型复核录音，
> 给出"加/删同义词"的建议。算法还在演进，误用可能改动词表——
> 改之前请先「备份并开始编辑」。

## 六、上架前还差的步骤

1. **启动器**：小 exe 拉起 `node.exe app/server.js` 并打开 `http://127.0.0.1:19600/`；
   也可以不做启动器，README 里直接写地址。
2. **首次运行下载模型**：M1 ≈127MB（压缩包）+ M2 ≈74MB，下载到 `data/models/asr/`。
3. **`lib/` 重建脚本**：`scripts/bootstrap-lib.cjs`（从 voice-plugin 或 npm 复制）。
4. **安装器/签名**：可选（zip 或 Inno Setup）。

## 七、DSH 插件的去留

VoiceKeys 已自带 `lib/`，**不再依赖 voice-plugin**。
但 `~/.dsh/profiles/desktop/package.json` 里仍注册着那个插件；
**删插件目录前要先把那一条从 profile 里移除**，否则 DSH 启动时会报插件缺失。
这一步涉及改 DSH 配置，需要用户确认后再做。
