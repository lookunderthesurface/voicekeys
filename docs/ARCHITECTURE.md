# 架构：三个常驻度不同的部分

VoiceKeys 分成三块，**只有 Executor 是常驻的**，另外两块按需运行。这个划分决定了
"哪些东西可以随便改而不影响稳定性"。

```
Planner（按需）     一句话 → 计划 JSON，或手写计划；负责"绑定哪些词、每个词做什么"
Calibrator（按需）  采集 → 复核 → 召回率/阈值建议；负责"我们到底准不准"
Executor（常驻）    一直在听：M1 提候选 → 静音门 → M2 确认 → 执行原语
```

## 一、Executor：两模型协同（核心，常驻）

```
麦克风 100ms/帧
   ├─→ 环形缓冲（最近 6 秒，供 M2 用，不随切句重置）
   └─→ M1 流式 ASR（zipformer-large，≈160MB，RTF≈0.07-0.15）→ 边说边出字
          ↓
       pipeline.propose(text)
          │  端尾匹配成功 → 候选（score=匹配分，degraded 表示缺字）
          │  端尾没成但最高分 ≥ candidateFloor(0.35) → 也是候选（宽松筛选）
          ↓ 候选成立
       ├─ 静音门开始计时（每词独立，0~5000ms）
       └─ pipeline.startConfirm()：把最近 5 秒音频发给 M2，**与门并行**
          ↓ 门到期
       pipeline.finish() → policy.decide() → fire / swap / drop
          ↓
       执行原语（常驻 PowerShell worker）
```

### 决策规则（`app/pipeline/policy.js`，可整体替换）

| 场景 | 结果 | 规则名 |
|---|---|---|
| M1 与 M2 都认同同一个词 | **执行** | `agree` |
| M1 达标命中，M2 听到别的词或是噪声 | **执行 M1**（唤醒/结束词特权） | `handy-authoritative` |
| M1 达标命中，M2 听到**另一个已知词** | **改判**给 M2 的词 | `m2-wins` |
| M1 只是缺字/前缀命中，M2 不认同 | **丢弃** | `degraded-needs-agreement` |
| M1 只是宽松候选（<阈值），M2 认同 | **执行** | `agree` |
| M2 超时/出错，M1 置信度高（≥0.95） | 执行 M1 | `m1-confident` |
| 其它 | 丢弃 | `m2-veto` / `no-evidence` |

**为什么唤醒/结束词有特权**：实测过一次 Handy 因为 M2 只听到「完了」而停不下来的事故。
用户必须**永远能把录音停掉**。

## 二、Planner（按需）：给用户的安全原语

- 内置 11 个原语（音量、静音、媒体、按键、Handy），参数自动夹紧，只接受白名单
- 一句话 → 计划：本地 Ollama / OpenAI 兼容 API / DeepSeek / 手写粘贴
- 用户自定义动作：`custom/*.json` + 脚本，受"快照 + 一键恢复"保护

**给用户 agent 的接口**：`GET /api/primitives`（原语清单与参数范围）、`POST /api/plan`（生成）、
`POST /api/bind`（绑定词）、`POST /api/gate`（改静音门）。契约见 `docs/EXTENDING.md`。

## 三、Calibrator（按需）：召回率与建议

- 采集"有信息量"的语音段（最多 100，存满即停）
- 复核：用 0.6B 模型重听，出对比报表（谁听错、规则是否太严）
- **策略评分账本**：真真 +1/+1、误触发只加分母、漏检扣分子 → 界面顶部那个百分比
- 建议：阈值扫描、谐音同义词候选、换词建议

**给用户 agent 的接口**：`GET /api/capture`（数据集）、`POST /api/calibrate/start`（复核）、
`GET /api/calibrate/report`（报表 + 阈值扫描）、`GET /api/score`（账本）。
用户可以用更强的模型自己跑一遍复核，把结果按同样格式喂回 `/api/calibrate/report` 的字段。

## 四、哪些文件可以换（都不需要改主程序）

| 想换什么 | 改哪里 | 生效方式 |
|---|---|---|
| 匹配算法 | `app/algorithms/user/*.js` + `settings.json` 的 `algorithms.matcher` | 重启 |
| 采样算法 | 同上（`algorithms.sampler`） | 重启 |
| 静音门策略 | 同上（`algorithms.gate`） | 重启 |
| 两模型协同规则 | `app/pipeline/policy.js` | 重启 |
| 原语 | `src/core.js` 的 `PRIMITIVES` | 重启 |
| 自定义动作 | `custom/*.json` + 脚本 | 立即 |

写坏了不会崩：算法载入失败会回退默认实现，`GET /api/algorithms` 能看到当前生效的是哪个、错在哪。

## 五、可观测性（排障用）

| 接口 | 内容 |
|---|---|
| `GET /api/state` | 词表、候选状态、确认模型状态、pipeline 最近一次决策 |
| `GET /api/pipeline` | 最近一次候选、M2 结果、策略裁决与理由 |
| `GET /api/score` | 识别率账本 |
| `GET /api/algorithms` | 当前生效的算法实现 |
| 日志 | `%LOCALAPPDATA%\dsh-voice\app.log`（追加、4MB 轮转） |
