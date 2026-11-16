// VoiceKeys APP：一个进程里装齐三件套，外加一个 Web GUI。
//
//   触发层  app/trigger.js    KWS 命中 + 1 秒静音门
//   计划层  app/planner.js    中文 → 计划；关键词 → 计划 的绑定表
//   校准层  app/calibrator.js 录音 → 扫阈值 → thresholds.json
//   执行层  app/executor.js   常驻 PowerShell worker 执行原语
//
//   node app/server.js [--port 19600] [--open] [--source wav:<file>] [--device 0]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const PATHS = require('./paths.js');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || PATHS.pluginRoot();
const sherpa = require(path.join(PLUGIN, 'node_modules', 'sherpa-onnx-node'));

const handy = require(path.join(PLUGIN, 'runtime', 'listener', 'handy.cjs'));
const planner = require('./planner.js');
const store = require('../src/store.js');
const { Executor } = require('./executor.js');
const { Trigger } = require('./trigger.js');
const algo = require('./algorithms');
const { match: matchOne, matchAtEnd, bestScore } = algo.matcher;
const { CandidateTracker } = require('./candidate.js');
const { Confirmer } = require('./confirmer.js');
const { Pipeline } = require('./pipeline');
const { Capture } = require('./capture.js');
const teacher = require('./teacher.js');
const { buildReport } = require('./report.js');
const { curate } = require('./curation.js');
const ledger = require('./scoreledger.js');
const providers = require('./providers.js');
const { makeSource, MicSource, findLiveDevice, SR, FRAME } = require('./sources.js');

// ---------------------------------------------------------------- 启动参数
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(argValue('--port', process.env.VK_PORT || 19600));
const OPEN_BROWSER = argv.includes('--open') && !argv.includes('--no-open');
const SOURCE_SPEC = argValue('--source', process.env.VK_SOURCE || 'mic');
// 不给 --device 时自动挑那个"真的会出数据"的设备（虚拟设备常常全是 0）
const DEVICE = argv.includes('--device') ? Number(argValue('--device', '0')) : Number(process.env.VK_DEVICE ?? -1);
const DEFAULT_THRESHOLD = 0.12;
const PAUSE_MS = Number(argValue('--pause', process.env.VK_PAUSE_MS || 1000));

// ---------------------------------------------------------------- 状态
const state = {
  mode: 'listening',          // listening | recording
  source: SOURCE_SPEC,
  device: DEVICE,
  micCount: MicSource.devices().length,
  words: [],
  events: [],
  lastResult: null,
  recording: false,
  takeSamples: [],
  takeStartedAt: 0,
  takes: 0,
  lastNote: '',
  startedAt: Date.now(),
  frames: 0,
  peak2s: 0,
  peakAt: 0,
  lastRms: 0,
  lastFrameAt: 0,
  feedError: '',
  selectedWord: '',
};

// Handy 录音看门狗：录太久就自动停。
// 起因：2026-11-15 我用「听我说」的录音做端到端测试，把这个词真的触发了，
// Handy 连续录了 3 小时没人发现。默认 10 分钟兜底。
const HANDY_WATCHDOG_MS = Number(process.env.VK_HANDY_WATCHDOG_MIN ?? 10) * 60000;
state.handyRecordingSince = 0;
if (HANDY_WATCHDOG_MS > 0) {
  setInterval(() => {
    try {
      if (!handy.isRecording()) { if (state.handyRecordingSince) state.handyRecordingSince = 0; return; }
      if (!state.handyRecordingSince) { state.handyRecordingSince = Date.now(); return; }
      const mins = (Date.now() - state.handyRecordingSince) / 60000;
      if (mins >= HANDY_WATCHDOG_MS / 60000) {
        handy.toggleTranscription();
        state.handyRecordingSince = 0;
        const human = mins >= 1 ? Math.round(mins) + ' 分钟' : Math.round(mins * 60) + ' 秒';
        log('看门狗: Handy 已连续录音 ' + human + '，自动停止');
        pushEvent({ type: 'guard', message: 'Handy 录音超过 ' + Math.round(HANDY_WATCHDOG_MS / 60000) + ' 分钟，已自动停止' });
      }
    } catch (e) { /* 看门狗自己不能把服务搞挂 */ }
  }, 20000).unref();
}

const config = require('./config.js');
config.ensure();   // 首次运行在这里建好用户目录
config.seedPlans();   // 空词表时塞一份示例，保证开箱可用
setHandyPathFromSettings();
const capture = new Capture(process.env.VK_CAPTURE_DIR || config.DIRS.capture);
const candidate = new CandidateTracker();
const confirmer = new Confirmer({ log });
// 连续环形缓冲：保存最近 6 秒音频，专供确认模型使用（不受切句影响）
const VOICED_GATE_MS = 300;   // 判断第一条件：这段音频必须真的有人说话

// 素材窗口：触发前 4 秒 + 触发后 1 秒（用户要求：把窗口往后挪，
// 这样"刚触发之后"的声音也在里面，便于回看"是不是之前喊过失败的那次"）
const CAPTURE_TAIL_MS = 1000;

/** 延迟一段时间再存素材：这样窗口能覆盖到"触发之后"的 CAPTURE_TAIL_MS */
function captureAfterFire(word, extra) {
  const t = setTimeout(() => {
    try {
      if (capture.full) autoCleanCapture();
      capture.recordDecision({
        audio: recentAudio(5000),
        word,
        ...extra,
      });
    } catch (e) { log('采集失败: ' + e.message); }
  }, CAPTURE_TAIL_MS);
  t.unref?.();
}
const AUDIO_RING_FRAMES = 60;          // 60 × 100ms = 6 秒
const AUDIO_RING = [];
const AUDIO_RMS = [];       // 与 AUDIO_RING 对齐的音量历史
const AUDIO_RING_AT = [];   // 与 AUDIO_RING 对齐的墙钟时间戳（ms）
const AUDIO_RING_T = [];    // 与 AUDIO_RING 对齐的音频时间轴（累计毫秒）
let AUDIO_TOTAL_MS = 0;     // 从进程启动到现在一共喂了多少毫秒音频
function pushAudioRing(frame, rms) {
  AUDIO_RING.push(frame);
  AUDIO_RMS.push(Number(rms) || 0);   // 音量历史要和音频帧严格对齐，否则切片会失效
  if (AUDIO_RING.length > AUDIO_RING_FRAMES) { AUDIO_RING.shift(); AUDIO_RMS.shift(); }
}
/**
 * 切出"这一句话"的音频：从最后一次连续有声区间的起点，一直到现在。
 * 没有任何有声帧时回退到最近 1 秒。maxMs 只是兜底上限。
 */
function speechAudio(maxMs = 4000, voiceRms = 0.03) {
  const n = AUDIO_RING.length;
  if (!n) return new Float32Array(0);

  // 关键：词中间可能有 100~200ms 的能量低谷（「暂停」和「视频」之间），
  // 不能一遇到静音就截断，否则 M2 只会拿到后半句（实测：M2 只听到「视频」）。
  const GAP_TOLERANCE = 4;          // 允许 400ms 的内部停顿
  let start = n - 1;
  let voicedSeen = false;
  let gap = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    const v = (AUDIO_RMS[i] || 0) > voiceRms;
    if (v) { voicedSeen = true; gap = 0; start = i; continue; }
    if (!voicedSeen) { start = i; continue; }   // 结尾静音：继续往左找语音
    gap += 1;
    if (gap > GAP_TOLERANCE) { start = Math.min(n - 1, i + gap + 2); break; }
  }
  if (!voicedSeen) start = Math.max(0, n - 10);
  start = Math.max(start, Math.max(0, n - Math.floor(maxMs / 100)));

  const picked = AUDIO_RING.slice(start);
  const total = picked.reduce((a, f) => a + f.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const f of picked) { out.set(f, off); off += f.length; }
  return out;
}

/**
 * 按时间戳切音频：从 startAt（墙钟 ms）到最新一帧。
 * 预留给"识别器能给出词级时间戳"的情况；当前主路径是 speechAudio() 的音量切片。
 */
/** 按音频时间轴切片（与真实时间无关，WAV 回放和麦克风都适用） */
function sliceByAudioTime(startMs, maxMs = 4000) {
  if (!AUDIO_RING_T.length) return new Float32Array(0);
  const floor = AUDIO_TOTAL_MS - maxMs;
  const from = Math.max(startMs, floor);
  const picked = [];
  for (let i = 0; i < AUDIO_RING.length; i += 1) {
    if ((AUDIO_RING_T[i] || 0) > from) picked.push(AUDIO_RING[i]);
  }
  if (!picked.length) return new Float32Array(0);
  const total = picked.reduce((a, f) => a + f.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const f of picked) { out.set(f, off); off += f.length; }
  return out;
}

function sliceByTime(startAt, maxMs = 4000) {
  if (!AUDIO_RING.length) return new Float32Array(0);
  const floor = Date.now() - maxMs;
  const from = Math.max(startAt, floor);
  const picked = [];
  for (let i = 0; i < AUDIO_RING.length; i += 1) {
    if ((AUDIO_RING_AT[i] || 0) >= from) picked.push(AUDIO_RING[i]);
  }
  if (!picked.length) return new Float32Array(0);
  const total = picked.reduce((a, f) => a + f.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const f of picked) { out.set(f, off); off += f.length; }
  return out;
}

/** 最近 maxMs 内"有声"的累计毫秒（用于判断这段音频到底有没有语音） */
function recentVoicedMs(maxMs = 3000, voiceRms = 0.03) {
  if (!AUDIO_RMS.length) return 0;
  const frames = Math.min(AUDIO_RMS.length, Math.max(1, Math.floor(maxMs / 100)));
  let voiced = 0;
  for (let i = AUDIO_RMS.length - frames; i < AUDIO_RMS.length; i += 1) {
    if ((AUDIO_RMS[i] || 0) > voiceRms) voiced += 1;
  }
  return voiced * 100;
}

function recentAudio(maxMs = 5000) {
  const frames = Math.min(AUDIO_RING.length, Math.max(1, Math.floor(maxMs / 100)));
  const picked = AUDIO_RING.slice(-frames);
  const total = picked.reduce((n, f) => n + f.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const f of picked) { out.set(f, off); off += f.length; }
  return out;
}

const pipeline = new Pipeline({
  m1: { matchAtEnd, bestScore },
  m2: { confirm: (audio) => confirmer.confirm(audio, 3000) },
  capture,
  audio: () => recentAudio(2500),   // 给 M2 的窗口：2.5 秒足够包含当前这个词
  words: () => state.words.map((w) => ({ word: w.word, planKey: w.planKey })),
  // 唤醒/结束词集合：策略用它禁止"把唤醒词改判成结束词"这类错动作
  handyWords: () => {
    const set = new Set();
    for (const w of state.words) {
      const entry = planner.lookup(w.word);
      const steps = entry && entry.plan && entry.plan.steps;
      if (Array.isArray(steps) && steps.some((s) => s.op === 'handy.set')) set.add(w.word);
    }
    return set;
  },
});
const executor = new Executor();

// 匹配阈值只有一个来源：settings.json 的 matchThreshold（默认 0.70）。
// 之前 server 里另外写死了一个 0.8 的门槛，和报表的 0.70 对不上，改配置也不生效。
// 重启后把上次的复核报表读回内存，界面不用再跑一遍才能看到结果
if (capture.report) state.lastReport = capture.report;

function matchThreshold() {
  const v = Number(providers.load().matchThreshold);
  return Number.isFinite(v) && v >= 0.3 && v <= 0.99 ? v : 0.70;
}
let source = null;
let spotter = null;
let trigger = null;
let loopRunning = false;

const LOG_FILE = config.FILES.log;
const LOG_MAX_BYTES = 4 * 1024 * 1024;

// 日志用追加写 + 按大小轮转：之前靠启动时重定向，每次重启都把上一次的现场截断，
// 出事（Handy 录了 3 小时）的时候根本查不出是哪一次触发的。
function appendLog(line) {
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* 文件还不存在 */ }
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

// 写 PID 文件：启停脚本靠它找进程，不靠命令行匹配（命令行是相对路径，容易认错）
const PID_FILE = path.join(config.DIRS.root, 'app.pid');
try {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => { try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ } });
} catch { /* ignore */ }

function log(msg) {
  const line = new Date().toISOString().slice(11, 23) + '  ' + msg;
  console.log(line);
  appendLog(line);
}

function pushEvent(evt) {
  state.events.unshift({ at: Date.now(), ...evt });
  state.events = state.events.slice(0, 12);
  if (evt.type === 'gate') {
    const gap = trigger && trigger.silenceBeforeFireMs != null ? ('，静音 ' + trigger.silenceBeforeFireMs + 'ms') : '';
    log('门到期: ' + evt.word + gap + '（等确认模型裁决）');
  }
  if (evt.type === 'fire') {
    const gap = trigger && trigger.silenceBeforeFireMs != null ? ('（说完后 ' + trigger.silenceBeforeFireMs + 'ms 执行）') : '';
    log('触发: ' + evt.word + gap);
  }
  if (evt.type === 'drop') log('丢弃: ' + evt.word + '（' + evt.reason + '）');
  if (evt.type === 'heard') log('听到: ' + evt.word);
  if (evt.type === 'confirm') log('确认[' + evt.word + ']: ' + evt.reason);
}

// ---------------------------------------------------------------- 关键词与阈值
function wordList() {
  const bound = planner.list().map((e) => e.say);
  const uniq = [...new Set(bound)];
  return uniq;
}

function wordItems(words) {
  // 给界面提供：词、计划标识、以及每个词自己的静音门毫秒数
  const planOf = {};
  const gateOf = {};
  for (const p of planner.listVerbose()) {
    planOf[p.say] = JSON.stringify((p.plan && p.plan.steps) || []);
    gateOf[p.say] = algo.gate.pauseMs({ pauseMs: p.pauseMs });
  }
  return words.map((w) => ({ word: w, planKey: planOf[w] || w, pauseMs: gateOf[w] == null ? 1000 : gateOf[w] }));
}

/** word → {m1, m2}，来自 plans.json 里每个词的 thresholds */
function wordMetaMap() {
  const map = new Map();
  for (const p of planner.listVerbose()) {
    map.set(p.say, p.thresholds || { m1: null, m2: null });
  }
  return map;
}

/** 设置里配了 handyPath 就通过环境变量交给 lib/runtime/listener/handy.cjs */
function setHandyPathFromSettings() {
  try {
    const s = require('./providers.js').load();
    if (s && typeof s.handyPath === 'string' && s.handyPath) process.env.HANDY_EXE = s.handyPath;
  } catch { /* ignore */ }
}

function rebuildSpotter() {
  // 识别交给 ASR 子进程；这里只维护"当前监听哪些词"和每个词的时序参数
  const words = wordList();
  const items = wordItems(words);
    // 词表带上 kind/aliasOf/thresholds，GUI 要用（主词/同义词要分开显示）
    const verbose = planner.listVerbose();
    state.words = items.map((it) => {
      const v = verbose.find((x) => x.say === it.word);
      return { ...it, kind: (v && v.kind) || 'primary', aliasOf: (v && v.aliasOf) || '', thresholds: (v && v.thresholds) || { m1: null, m2: null } };
    });
  if (trigger) {
    const meta = {};
    for (const p of planner.listVerbose()) {
      // handy.set 类（唤醒词/结束词）天生出现在连续说话里：说完「我说完了」继续解释是常态，
      // 实测因此丢过一次真触发。这类词忽略"还在说"的判定，其余词保持严格。
      const isHandy = Array.isArray(p.plan && p.plan.steps) && p.plan.steps.some((s) => s.op === 'handy.set');
      // noLead 恒为 true：端尾匹配已经保证"词就在句尾"，不需要再用"说话太久"来挡
      // 所有词都忽略"还在说话"判定：真正的判据是**文本是否变化**（见 pipeline/policy）；
      // 音量判定会误杀"词说到一半就匹配上、后半句还在继续"的正常情况（实测踩过）。
      meta[p.say] = { word: p.say, pauseMs: algo.gate.pauseMs({ pauseMs: p.pauseMs }), noLead: true, ignoreNoisy: true };
    }
    trigger.meta = meta;
    trigger.words = items;
  }
  log(`监听词表：${items.length} 个（${items.map((i) => i.word).join(' / ')}）`);
}
// 休眠/设备掉线检测：超过 60 秒没收到任何音频帧，就认为音频链路断了，重启音频源与 ASR
setInterval(() => {
  const gap = Date.now() - lastAudioAt;
  if (gap < 60000) return;
  if (state.mode === 'recording') return;
  log('音频已静默 ' + Math.round(gap / 1000) + ' 秒（可能刚休眠过），尝试恢复音频源');
  lastAudioAt = Date.now();
  try { if (source && source.stop) source.stop(); } catch { /* ignore */ }
  try { startLoop(); } catch (e) { log('恢复音频源失败: ' + (e && e.message)); }
  try { if (typeof startAsrWorker === 'function') startAsrWorker(); } catch { /* ignore */ }
}, 20000).unref?.();

// ---------------------------------------------------------------- ASR 子进程
// 识别放在独立进程里，并把它的 CPU 亲和性钉在小核（E 核）上，
// 保证不抢大核；主进程（音频采集/触发/UI）不绑，交给系统调度。
const E_CORE_MASK = process.env.VK_E_CORE_MASK || '0x3fc0';   // 本机小核 = 逻辑核 6..13
let asrProc = null;
let asrRestartTimer = null;
let m2PreloadAt = 0;
let lastAudioAt = Date.now();   // 最近一次收到音频帧的时间（用于发现休眠/设备掉线）
let preloadLoggedAt = 0;
let asrReady = false;
let asrBuffer = '';

function pinToECores(pid) {
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr]${E_CORE_MASK}`,
    ], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    log(`ASR 进程 #${pid} 已绑定到小核（掩码 ${E_CORE_MASK}）`);
    return true;
  } catch (e) {
    log(`绑定小核失败（不影响识别）：${e.message}`);
    return false;
  }
}

/** 采集满了之后：按设置决定"自动删废数据继续录"还是"停" */
function autoCleanCapture() {
  const providers = require('./providers.js');
  const settings = providers.load();
  if (!settings.captureAutoClean) return false;
  try {
    const { prune } = require('../scripts/capture-clean.cjs');
    const r = prune();
    capture.reload();
    if (r.removed > 0) log('采集已满，自动清理 ' + r.removed + ' 条废数据（保留 ' + r.kept + ' 条）');
    return r.removed > 0;
  } catch (e) {
    log('自动清理失败: ' + (e && e.message));
    return false;
  }
}

function startAsrWorker() {
  const workerPath = path.join(__dirname, 'asr-worker.js');
  asrProc = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  pinToECores(asrProc.pid);

  asrProc.stdout.on('data', (chunk) => {
    asrBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = asrBuffer.indexOf('\n')) >= 0) {
      const line = asrBuffer.slice(0, idx).trim();
      asrBuffer = asrBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try { handleAsrMessage(msg); } catch (e) { log('ASR 消息处理失败: ' + (e && e.message)); }
    }
  });
  // 子进程死掉后 stdin 会异步抛 EPIPE，没有这个监听器会直接把主进程带走
  asrProc.stdin.on('error', (e) => {
    asrReady = false;
    const code = (e && e.code) || 'EPIPE';
    if (code !== 'EPIPE') log('ASR stdin 错误: ' + code);
  });

  asrProc.stderr.on('data', (c) => { const s = String(c).trim(); if (s) log('ASR stderr: ' + s.slice(0, 200)); });
  asrProc.on('exit', (code) => {
    asrReady = false;
    state.asrReady = false;          // 界面也要立刻显示“未就绪”，否则状态是假的
    asrProc = null;
    if (state.shuttingDown) return;  // 主动退出就别再拉起来了
    log(`ASR 进程退出（code=${code}），2 秒后重启`);
    if (asrRestartTimer) clearTimeout(asrRestartTimer);
    asrRestartTimer = setTimeout(() => {
      asrRestartTimer = null;
      if (!state.shuttingDown) startAsrWorker();
    }, 2000);
  });
}

function handleAsrMessage(msg) {
  if (msg.type === 'ready') {
    asrReady = true;
    state.asrReady = true;
    log(`ASR 就绪（加载 ${msg.loadMs}ms，${msg.int8 ? 'int8' : 'fp32'}）`);
    if (asrPrequeue.length) {
      log(`补灌启动期间攒下的 ${asrPrequeue.length} 帧`);
      const pending = asrPrequeue.splice(0, asrPrequeue.length);
      for (const frame of pending) feedAsr(frame);
    }
    return;
  }
  if (msg.type === 'error') { log('ASR 错误: ' + msg.message); return; }
  if (msg.type !== 'text') return;

  state.asrText = msg.text || '';


  // 一句话结束：素材改为"按判定记录"（见 confirmDecision 里的 recordDecision），这里只做收尾
  if (msg.final) return;
  const words = state.words.map((w) => ({ word: w.word, planKey: w.planKey }));
  if (!words.length || !state.asrText) return;
  // 只认"整句话以它结尾"的词：这样「静音门的时间里面」不会被当成「静音」
  // 只认"整句话以它结尾"的词：这样「静音门的时间里面」不会被当成「静音」
  // 交给流水线判断："这句话像不像某个词"。M1 只负责提出候选，宽松一点没关系。
  const threshold = matchThreshold();
  const wordList = state.words.map((w) => ({ word: w.word, planKey: w.planKey }));
  const voicedMs = recentVoicedMs(3000);
  const cand = pipeline.propose(state.asrText, { threshold, words: wordList, voicedMs, wordMeta: wordMetaMap() });

  if (!cand) {
    candidate.invalidate('文本已变化');
    if (trigger && trigger.pending) {
      // 唤醒/结束词（ignoreNoisy）天生出现在连续说话里：
      // 说完「我说完了」立刻接话是常态，不该把候选取消掉（用户 B 实验就是死在这里）。
      const pendingWord = trigger.pending.word;
      const pendingMeta = trigger.meta ? trigger.meta[pendingWord] : null;
      const ignoreNoisy = Boolean(pendingMeta && pendingMeta.ignoreNoisy);
      const cancelled = ignoreNoisy ? null : trigger.cancelPending('又出现了新文字');
      // 允许立刻重说同一个词（否则 2.5 秒去重会把它挡掉）
      if (cancelled && state.lastWordFireAt) delete state.lastWordFireAt[cancelled];
    }
    return;
  }

  // 候选成立：先判要不要走"快速通道"（M1 够自信就不叫 M2）
  if (!state.pendingConfirm || state.pendingConfirm.word !== cand.word) {
    const planEntry = cand.word ? planner.lookup(cand.word) : null;
    const candIsHandy = Boolean(planEntry && planEntry.plan && Array.isArray(planEntry.plan.steps)
      && planEntry.plan.steps.some((s) => s.op === 'handy.set'));
    const fast = pipeline.policy.shouldFastPath({ score: cand.score, isHandy: candIsHandy, voicedMs });
    if (fast) {
      state.pendingConfirm = { word: cand.word, candidate: cand, fast: true, audio: null, promise: null };
      log('快速通道: ' + cand.word + '（M1 ' + cand.score.toFixed(2) + '，跳过 M2）');
    } else {
      const h = pipeline.startConfirm();
      if (process.env.VK_DEBUG_AUDIO) log('[dbg] 候选 ' + cand.word + ' 音频 ' + (h.audio ? (h.audio.length / 16000).toFixed(2) : 'null') + 's promise=' + Boolean(h.promise));
      state.pendingConfirm = { word: cand.word, candidate: cand, fast: false, ...h };
    }
  }
  candidate.update(state.asrText, { word: cand.word, score: cand.score, how: cand.how });
  state.lastWordFireAt = state.lastWordFireAt || {};
  if (Date.now() - (state.lastWordFireAt[cand.word] || 0) >= 2500) {
    if (!(trigger && trigger.pending)) {
      if (trigger) trigger.queue(cand.word);
      log('门开始计时：M2 已加载 ' + (m2PreloadAt ? (Date.now() - m2PreloadAt) : 0) + 'ms' + (m2PreloadAt ? '' : '（未预热）'));
      capture.markFired(cand.word, state.asrText);
    }
  }
}

// ASR 模型要 ~0.9 秒加载；这期间的音频先攒着（上限 100 帧 = 10 秒），就绪后一次性灌进去。
// 只在启动阶段存在，之后就绪后不再缓存，不占常驻资源。
const ASR_PREQUEUE_MAX = 100;
const asrPrequeue = [];

function feedAsr(samples) {
  if (!asrProc) return;
  if (!asrReady) {
    asrPrequeue.push(samples);
    if (asrPrequeue.length > ASR_PREQUEUE_MAX) asrPrequeue.shift();
    return;
  }
  state.asrFrames = (state.asrFrames || 0) + 1;
  const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  if (!asrProc || !asrProc.stdin || asrProc.stdin.destroyed || !asrProc.stdin.writable) {
    asrReady = false;
    return;
  }
  try { asrProc.stdin.write(JSON.stringify({ type: 'audio', samples: buf.toString('base64') }) + '\n'); } catch { asrReady = false; }
}
// ---------------------------------------------------------------- Handy 控制
let handyCached = null;
let handyProbeAt = 0;
function handyIsRecording() {
  // 只返回缓存值；真正的探测在后台异步做，避免每秒同步起 reg.exe 卡住音频循环
  return handyCached;
}
function startHandyWatcher() {
  const tick = () => {
    const now = Date.now();
    if (now - handyProbeAt < 1200) return;
    handyProbeAt = now;
    try {
      handy.isRecordingAsync((v) => { handyCached = v; });
    } catch { /* ignore */ }
  };
  tick();
  setInterval(tick, 600).unref?.();
}

function handyToggle(reason) {
  try {
    handy.toggleTranscription();
    state.handy = { at: Date.now(), reason };
    pushEvent({ type: 'handy', reason });
    log(`Handy: ${reason}`);
  } catch (e) {
    pushEvent({ type: 'error', message: 'Handy 调用失败: ' + e.message });
  }
}

const sleepSync = (ms) => {
  try { require('node:child_process').execSync('powershell.exe -NoLogo -NoProfile -Command "Start-Sleep -Milliseconds ' + ms + '"', { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
};

/** 读 Handy 真实状态：注册表更新有延迟，多试几次 */
async function handyRead(tries = 4, gapMs = 120) {
  for (let i = 0; i < tries; i += 1) {
    const v = handyIsRecording();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

/** 把 Handy 调到目标状态（true=在录 / false=停），并等它真的到位 */
async function handyEnsure(target, wordLabel) {
  const before = await handyRead();
  if (before === target) {
    pushEvent({ type: 'ignored', word: wordLabel, reason: target ? 'Handy 已经在录' : 'Handy 本来就没录' });
    return before;
  }
  handyToggle(target ? '开始录音' : '停止录音');
  // toggle 是异步 spawn，状态要等一会才翻转
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 150));
    const now = handyIsRecording();
    if (now === target) return now;
  }
  return handyIsRecording();
}


// ---------------------------------------------------------------- 执行
/**
 * 门到期时的最终裁决：交给 pipeline（M1 候选 + M2 确认 → 策略）。
 * 返回 {word, source} 或 null（null = 放弃执行）。
 */
async function confirmDecision(word) {
  const pc = state.pendingConfirm;
  state.pendingConfirm = null;
  if (!pc) return { word, source: 'no-candidate' };
  if (pc.fast) {
    // 素材①：M1 非常自信，没问 M2 —— 只在真要执行时录，窗口延后 1 秒
    captureAfterFire(word, {
      m1Score: pc.candidate ? pc.candidate.score : 1,
      m1How: pc.candidate ? pc.candidate.how : 'exact',
      verdict: 'fast-path', path: 'fast',
    });
    return { word, source: 'fast-path' };
  }

  const entry = planner.lookup(word);
  const isHandy = Boolean(entry && entry.plan && Array.isArray(entry.plan.steps)
    && entry.plan.steps.some((s) => s.op === 'handy.set'));

  const verdict = await pipeline.finish(
    pc.candidate || { word, score: 1, how: 'exact' },
    pc,
    { threshold: matchThreshold(), isHandy, wordMeta: wordMetaMap(), retryAudio: () => {
      return recentAudio(3000);   // 门到期时的完整窗口
    }, },
  );

  pushEvent({ type: 'confirm', word, reason: verdict.reason });

  // 素材②：只在"真的要执行"时录（M2 否决的、以及被新文字取消的都不占素材名额）
  if (verdict.action === 'fire' || verdict.action === 'swap') {
    captureAfterFire(verdict.word || word, {
      m1Score: pc.candidate ? pc.candidate.score : 1,
      m1How: pc.candidate ? pc.candidate.how : 'exact',
      m2Text: verdict.m2 ? verdict.m2.text : '',
      m2Word: verdict.m2 ? verdict.m2.word : '',
      verdict: verdict.rule,
      path: 'm2',
    });
  }

  if (verdict.action === 'fire') return { word: verdict.word || word, source: verdict.rule };
  if (verdict.action === 'swap') {
    capture.remarkWord(verdict.word);
    return { word: verdict.word, source: verdict.rule };
  }
  capture.markSuppressed();
  return null;
}


async function fireWord(word) {
  // 两个模型的协同点：非流式模型在门内重听这段音频，它的结论优先
  const decided = await confirmDecision(word);
  if (!decided) {
    state.lastResult = { word, ok: false, error: '被确认模型否决' };
    return;
  }
  word = decided.word;
  pushEvent({ type: 'fire', word });

  const entry = planner.lookup(word);
  if (!entry) {
    state.lastResult = { word, ok: false, error: '未绑定' };
    pushEvent({ type: 'error', message: '未绑定: ' + word });
    return;
  }
  try {
  if (process.env.VK_DRY_RUN === '1' || process.argv.includes('--dry-run')) {
    const steps = JSON.stringify((entry.plan && entry.plan.steps) || []);
    log('[dry-run] 本应执行: ' + word + ' → ' + steps);
    state.lastResult = { word, at: Date.now(), ok: true, dryRun: true };
    pushEvent({ type: 'dry', word, detail: steps });
    return;
  }
    const out = await executor.run(entry.plan);
    state.lastResult = { word, at: Date.now(), ...out };
    pushEvent({ type: 'result', word, ok: out.ok, detail: summarize(out) });
  } catch (e) {
    state.lastResult = { word, ok: false, error: String(e && e.message) };
    pushEvent({ type: 'error', message: String(e && e.message) });
  }
}

function summarize(out) {
  if (!out || !out.ok) return (out && out.errors && out.errors.join(';')) || '失败';
  const r = (out.execution && out.execution.results) || [];
  return r.map((x) => x.op + (x.ok ? '✓' : '✗')).join(' → ') + ` (${out.execution.elapsedMs}ms)`;
}

// ---------------------------------------------------------------- 主循环
/** 用子进程探测可用麦克风，避免"探测完再打开同一设备就全是 0"的问题 */
function probeDeviceInChild() {
  try {
    const { spawnSync } = require('node:child_process');
    const out = spawnSync(process.execPath, [path.join(__dirname, 'probe-device.js')], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const text = String(out.stdout || '');
    for (const line of text.split(/\r?\n/)) if (line.startsWith('DEVICE ')) log('  ' + line.slice(7));
    const m = /INDEX=(\d+)/.exec(text);
    return m ? Number(m[1]) : -1;
  } catch (e) {
    log('探测麦克风失败: ' + e.message);
    return -1;
  }
}

async function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    let device = DEVICE;
    if (!SOURCE_SPEC.startsWith('wav:') && device < 0) {
      device = probeDeviceInChild();
      state.device = device;
      if (device >= 0) log(`自动选择麦克风 #${device}`);
    }
    source = makeSource(SOURCE_SPEC, device);
    source.start();
    log('音频源: ' + (SOURCE_SPEC.startsWith('wav:') ? SOURCE_SPEC : `麦克风 #${device}`));
  } catch (e) {
    log('打开音频源失败: ' + e.message);
    loopRunning = false;
    return;
  }
  void (async () => {
    while (loopRunning) {
      let frame;
      try {
        frame = await source.read();
      } catch (e) {
        state.readFails = (state.readFails || 0) + 1;
        if (state.readFails <= 3) log('读取失败(' + state.readFails + '): ' + e.message);
        // 连续失败太多次说明录音链路已经坏了（麦克风被抢/设备掉线/驱动卡死）：
        // 停掉旧源、按退避重建。只记前几条，避免日志刷屏。
        if (state.readFails >= 20) {
          log('音频连续失败 ' + state.readFails + ' 次，重建音频源');
          state.readFails = 0;
          try { if (source && source.stop) source.stop(); } catch { /* ignore */ }
          await new Promise((r) => setTimeout(r, 1000));
          try { startLoop(); } catch (err) { log('重建音频源失败: ' + (err && err.message)); }
        }
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (frame) lastAudioAt = Date.now();
      if (frame) state.readFails = 0;
  if (!frame) {
        if (!state.nullLogged) {
          state.nullLogged = true;
          log('音频源已结束');
          if (asrProc && asrReady) { try { asrProc.stdin.write(JSON.stringify({ type: 'flush' }) + '\n'); } catch { /* ignore */ } }
        }
        // 没有音频（WAV 放完 / 麦克风暂时没数据）也要推进时间，
        // 否则"等 1 秒静音"的计时永远不会到点。
        if (trigger) trigger.feedVoice(new Float32Array(FRAME));
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      // 诊断：帧计数与当前电平，用来判断"麦克风到底有没有在出数据"
      state.frames += 1;
      let sum = 0;
      for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      state.lastRms = rms;
      // 有人声就把 M2 预热起来（空闲 15 分钟会卸载，第一次唤醒不该多等 300ms）
      if (rms > 0.012) {
        try {
          if (!m2PreloadAt) { m2PreloadAt = Date.now(); log('检测到人声，预热确认模型'); }
          confirmer.preload();
        } catch { /* 预热失败不影响主流程 */ }
      }
      const nowMs = Date.now();
      if (nowMs - (state.peakAt || 0) > 2000) { state.peak2s = 0; state.peakAt = nowMs; }
      if (rms > (state.peak2s || 0)) state.peak2s = rms;
      state.lastFrameAt = Date.now();

      if (state.mode !== 'recording') {
        try { capture.pushFrame(frame, rms); } catch { /* ignore */ }
        try { pushAudioRing(frame, rms); } catch { /* ignore */ }   // 供确认模型使用，不受切句影响
        try { feedAsr(frame); } catch (e) { if (!state.asrError) { state.asrError = e.message; log('喂 ASR 失败: ' + e.message); } }
      }
      if (state.mode === 'recording') {
        for (let i = 0; i < frame.length; i += 1) state.takeSamples.push(frame[i]);
        continue;
      }
      if (trigger) {
        try {
          trigger.feedVoice(frame);
        } catch (e) {
          if (!state.feedError) {
            state.feedError = String(e && e.message);
            log('触发层异常: ' + state.feedError);
          }
        }
      }
    }
  })();
}

function stopLoop() {
  loopRunning = false;
  if (source) {
    try { source.stop(); } catch { /* ignore */ }
    source = null;
  }
}

// ---------------------------------------------------------------- 录音（校准）
// ---------------------------------------------------------------- HTTP
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function snapshot() {
  return {
    mode: state.mode,
    source: state.source,
    device: state.device,
    micCount: state.micCount,
    words: state.words,
    takes: state.takes,
    takeMs: state.recording ? Date.now() - state.takeStartedAt : 0,
    takeStartedAt: state.recording ? state.takeStartedAt : 0,

    frames: state.frames,
    lastRms: Number((state.lastRms || 0).toFixed(4)),
    peak2s: Number((state.peak2s || 0).toFixed(4)),
    lastFrameAgoMs: state.lastFrameAt ? Date.now() - state.lastFrameAt : -1,
    feedError: state.feedError,
    selectedWord: state.selectedWord || '',
    max: state.max,
    lastNote: state.lastNote,
    lastResult: state.lastResult,
    events: state.events.slice(0, 8),
    uptimeMs: Date.now() - state.startedAt,
    plans: planner.listVerbose(),
    pauseMs: PAUSE_MS,
    queueLength: state.queueLength || 0,

    handyRecording: handyIsRecording(),
    asrReady: Boolean(state.asrReady),
    capture: { ...capture.state(), optimizedWords: capture.optimized() },
    score: ledger.summary(ledger.load(capture.dir)),
    candidate: candidate.state(),
    confirmer: confirmer.state(),
    pipeline: pipeline.state(),
    calibrating: Boolean(state.calibrating),
    models: (() => {
      const dir = path.join(config.DIRS.models, 'asr');
      const m1 = fs.existsSync(path.join(dir, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23', 'encoder-epoch-99-avg-1.int8.onnx'));
      const m2 = fs.existsSync(path.join(dir, 'sherpa-onnx-paraformer-zh-small-2024-03-09', 'model.int8.onnx'));
      return { ok: m1 && m2, m1, m2, dir, downloading: Boolean(state.downloadingModels) };
    })(),
    calibrateProgress: state.calibrateProgress || null,
    asrText: state.asrText || '',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'ui.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (p === '/api/state') return json(res, 200, snapshot());

    // ---- 校准

    // ---- 计划
    if (p === '/api/word/thresholds' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const store = require('../src/store.js');
    const r = store.setThresholds(body.word, { m1: body.m1, m2: body.m2 });
    if (r.ok) { rebuildSpotter(); log('阈值已更新: ' + body.word + ' M1=' + body.m1 + ' M2=' + body.m2); }
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/gate' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const word = String(body.word || '');
      const ms = Number(body.pauseMs);
      if (!word || !Number.isFinite(ms) || ms < 0 || ms > 5000) return json(res, 400, { ok: false, error: '参数不对（word / pauseMs 0~5000）' });
      const r = store.setGate(word, ms);
      if (!r.ok) return json(res, 400, r);
      rebuildSpotter();
      pushEvent({ type: 'gate', word, reason: '静音门设为 ' + ms + 'ms' });
      return json(res, 200, { ok: true, word, pauseMs: ms, ...snapshot() });
    }
    if (p === '/api/plans') return json(res, 200, { plans: planner.list() });
    if (p === '/api/plans/path') {
      const store = require('../src/store.js');
      return json(res, 299, {
        path: store.STORE,
        how: '把 {"say":"关键词","plan":{"steps":[...]}} 追加进这个文件即可绑定；也可以直接在界面里粘贴 JSON',
        template: { say: '音量四十', plan: { steps: [{ op: 'audio.volume.set', percent: 40 }] } },
      });
    }
    if (p === '/api/plan' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.text) return json(res, 400, { error: 'text required' });
      const gen = await providers.generatePlan(body.text);
      return json(res, 200, gen);
    }
    if (p === '/api/settings' && req.method === 'GET') {
      return json(res, 200, providers.publicView());
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 界面回传打码的 key 时不要覆盖真实 key
      if (typeof body.openaiKey === 'string' && body.openaiKey.includes('****')) delete body.openaiKey;
      if (typeof body.deepseekKey === 'string' && body.deepseekKey.includes('****')) delete body.deepseekKey;
      providers.save(body);
      // 采集上限/开关改了要立刻生效（capture 只在 reload 时读设置）
      try { capture.reload(); rebuildSpotter(); setHandyPathFromSettings(); } catch { /* ignore */ }
      return json(res, 200, { ok: true, settings: providers.publicView() });
    }
    if (p === '/api/ollama/status') {
      return json(res, 200, await providers.ollamaStatus());
    }
    if (p === '/api/ollama/start' && req.method === 'POST') {
      return json(res, 200, await providers.ollamaStart());
    }

    if (p === '/api/bind' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.phrase || !body.plan) return json(res, 400, { error: 'phrase and plan required' });
      const out = planner.bind(body.phrase, body.plan, { model: body.model || 'manual' });
      if (out.ok) rebuildSpotter();
      return json(res, 200, out);
    }
    if (p === '/api/unbind' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ok = planner.remove(body.phrase);
      rebuildSpotter();
      return json(res, 200, { ok });
    }
    if (p === '/api/run' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const out = await executor.run(body.plan || (planner.lookup(body.phrase) || {}).plan);
      state.lastResult = { word: body.phrase || '(直接执行)', at: Date.now(), ...out };
      return json(res, 200, out);
    }

    if (p === '/api/handy/start' && req.method === 'POST') {
      const r = await executor.run({ steps: [{ op: 'handy.set', target: 'on' }] });
      const rec = (r.execution && r.execution.results && r.execution.results[0] || {}).recording;
      return json(res, 200, { ok: true, handyRecording: rec, ...snapshot() });
    }
    if (p === '/api/handy/stop' && req.method === 'POST') {
      const r = await executor.run({ steps: [{ op: 'handy.set', target: 'off' }] });
      const rec = (r.execution && r.execution.results && r.execution.results[0] || {}).recording;
      return json(res, 200, { ok: true, handyRecording: rec, ...snapshot() });
    }
    // ---- 采集（自校准的数据来源）
    if (p === '/api/score') {
      return json(res, 200, ledger.summary(ledger.load(capture.dir)));
    }
    // ---------------- 算法（可自定义 + 一键还原） ----------------
  if (p === '/api/algorithms/source') {
    const role = url.searchParams.get('role') || 'matcher';
    const algo = require('./algorithms');
    const userFile = path.join(algo.userDir, role + '.js');
    const defFile = path.join(__dirname, 'algorithms', role + '.default.js');
    const active = fs.existsSync(userFile) ? 'user' : 'default';
    const source = fs.readFileSync(fs.existsSync(userFile) ? userFile : defFile, 'utf8');
    return json(res, 200, { role, active, source, file: path.basename(fs.existsSync(userFile) ? userFile : defFile) });
  }

  if (p === '/api/algorithms/save' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const role = String(body.role || '');
    const source = String(body.source || '');
    const algo = require('./algorithms');
    if (!algo.roles.includes(role)) return json(res, 400, { error: '未知算法: ' + role });
    // 先验证语法与必填方法，坏代码绝不落盘
    try {
      // eslint-disable-next-line no-new-func
      const mod = { exports: {} };
      new Function('module', 'exports', 'require', source)(mod, mod.exports, require);
      const required = { matcher: ['match', 'bestScore'], sampler: ['decide'], gate: ['pauseMs', 'ignoreNoisy'] }[role] || [];
      const missing = required.filter((m) => typeof mod.exports[m] !== 'function');
      if (missing.length) throw new Error('缺少方法: ' + missing.join(', '));
    } catch (e) {
      return json(res, 400, { error: '代码没通过检查: ' + (e && e.message) });
    }
    const target = path.join(algo.userDir, role + '.js');
    fs.writeFileSync(target, source, 'utf8');
    const settings = providers.load();
    const algorithms = Object.assign({}, settings.algorithms || {}, { [role]: role + '.js' });
    providers.save({ algorithms });
    log('算法已保存: ' + role + ' → ' + path.basename(target) + '（重启后生效）');
    return json(res, 200, { ok: true, role, file: role + '.js', needRestart: true });
  }

  if (p === '/api/algorithms/restore' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const role = String(body.role || '');
    const algo = require('./algorithms');
    const target = path.join(algo.userDir, role + '.js');
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch { /* ignore */ }
    const settings = providers.load();
    const algorithms = Object.assign({}, settings.algorithms || {});
    delete algorithms[role];
    providers.save({ algorithms });
    log('算法已还原: ' + role);
    return json(res, 200, { ok: true, role, needRestart: true });
  }

  if (p === '/api/algorithms/backup' && req.method === 'POST') {
    try {
      const { backup } = require('../scripts/backup-algorithms.cjs');
      const meta = backup();
      log('算法已备份: ' + meta.files.length + ' 个文件 → ' + path.basename(meta.dir));
      return json(res, 200, { ok: true, count: meta.files.length, dir: path.basename(meta.dir), files: meta.files });
    } catch (e) {
      return json(res, 500, { error: String(e && e.message) });
    }
  }

  if (p === '/api/algorithms/restore-all' && req.method === 'POST') {
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-algorithms.cjs')], { encoding: 'utf8' });
      log('算法已还原到最近备份');
      return json(res, 200, { ok: true, output: out.trim().split('\n'), needRestart: true });
    } catch (e) {
      return json(res, 500, { error: String(e && e.message) });
    }
  }

  if (p === '/api/restart' && req.method === 'POST') {
    json(res, 200, { ok: true, restarting: true });
    log('按界面请求重启…');
    setTimeout(() => {
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'lifecycle.cjs'), 'stop'], {
        windowsHide: true, stdio: 'ignore', detached: true,
      });
      child.unref();
      setTimeout(() => process.exit(0), 800);
    }, 200);
    return;
  }

  // ---------------- 模型：首次运行检测 + 下载 / 指定本地 ----------------
  if (p === '/api/models/status') {
    const dir = path.join(config.DIRS.models, 'asr');
    const m1 = path.join(dir, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23', 'encoder-epoch-99-avg-1.int8.onnx');
    const m2 = path.join(dir, 'sherpa-onnx-paraformer-zh-small-2024-03-09', 'model.int8.onnx');
    return json(res, 200, {
      dir,
      m1: fs.existsSync(m1),
      m2: fs.existsSync(m2),
      missing: !fs.existsSync(m1) || !fs.existsSync(m2),
      downloading: Boolean(state.downloadingModels),
    });
  }

  if (p === '/api/models/download' && req.method === 'POST') {
    if (state.downloadingModels) return json(res, 200, { ok: true, already: true });
    state.downloadingModels = true;
    log('开始下载语音模型（约 155MB）…');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'fetch-models.cjs')], {
      windowsHide: true, stdio: 'ignore', cwd: path.join(__dirname, '..'),
    });
    child.on('exit', (code) => {
      state.downloadingModels = false;
      log('模型下载结束（exit ' + code + '），重启后生效');
    });
    return json(res, 200, { ok: true, started: true });
  }

  if (p === '/api/models/use-local' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const dir = String(body.dir || '').trim();
    if (!dir || !fs.existsSync(dir)) return json(res, 400, { error: '目录不存在: ' + dir });
    // 允许用户给"包含两个模型文件夹的目录"，也允许直接给其中的某个
    const hasM1 = fs.existsSync(path.join(dir, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23', 'encoder-epoch-99-avg-1.int8.onnx'))
      || fs.existsSync(path.join(dir, 'encoder-epoch-99-avg-1.int8.onnx'));
    const hasM2 = fs.existsSync(path.join(dir, 'sherpa-onnx-paraformer-zh-small-2024-03-09', 'model.int8.onnx'))
      || fs.existsSync(path.join(dir, 'model.int8.onnx'));
    if (!hasM1 && !hasM2) return json(res, 400, { error: '这个目录里没找到模型文件（需要 M1 的 encoder-*.int8.onnx 或 M2 的 model.int8.onnx）' });
    providers.save({ modelsDir: dir });
    log('模型目录已指向: ' + dir);
    return json(res, 200, { ok: true, dir, needRestart: true });
  }

  if (p === '/api/selfcheck') {
    const sc = require('./selfcheck.js');
    return json(res, 200, sc.run({ port: PORT, listening: true }));
  }

  if (p === '/api/algorithms') {
      return json(res, 200, { active: algo.status, userDir: algo.userDir, roles: algo.roles });
    }
    if (p === '/api/pid') {
      return json(res, 200, { pid: process.pid, startedAt: state.startedAt || null });
    }
    if (p === '/api/capture') {
      return json(res, 200, { ...capture.state(), entries: capture.list().slice(-40) });
    }
    if (p === '/api/capture/toggle' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      capture.setEnabled(body.enabled !== false);
      return json(res, 200, capture.state());
    }
    if (p === '/api/capture/diagnostic' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.minutes === 0) { capture.stopDiagnostic(); return json(res, 200, { ok: true, ...capture.state() }); }
      const st = capture.startDiagnostic(Number(body.minutes) || 10);
      log('进入诊断模式：' + st.diagnosticLeftMs / 60000 + ' 分钟内保存每一句话（最多 40 段）');
      return json(res, 200, { ok: true, ...st });
    }
    if (p === '/api/capture/clear' && req.method === 'POST') {
      capture.clear();
      state.lastReport = null;
      return json(res, 200, capture.state());
    }

    // ---- 校准：用老师模型批量转写采集到的录音，出对比报表
    if (p === '/api/calibrate/state') {
      return json(res, 200, { running: Boolean(state.calibrating), progress: state.calibrateProgress || null, teacher: teacher.modelInfo() });
    }
    if (p === '/api/calibrate/report') {
      return json(res, 200, state.lastReport || null);
    }
    if (p === '/api/capture/clean' && req.method === 'POST') {
    try {
      const { prune } = require('../scripts/capture-clean.cjs');
      const r = prune();
      capture.reload();
      log('手动清理采集数据：删除 ' + r.removed + ' 条，保留 ' + r.kept + ' 条');
      json(res, 200, { ok: true, ...r });
    } catch (e) {
      json(res, 500, { error: String(e && e.message) });
    }
    return;
  }

  // ---------------- 校准建议（实验功能，默认关闭）----------------
  if (p === '/api/calibrate/suggestions') {
    const providers = require('./providers.js');
    const enabled = Boolean(providers.load().calibratorEnabled);
    const file = path.join(config.DIRS.capture, 'suggestions.json');
    let data = null;
    let at = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); at = data.at; } catch { data = null; }
    return json(res, 200, { enabled, running: Boolean(state.calibrating), at, data });
  }

  if (p === '/api/calibrate/run' && req.method === 'POST') {
    const providers = require('./providers.js');
    if (!providers.load().calibratorEnabled) {
      return json(res, 400, { error: '校准是实验功能，默认关闭。先在设置里打开。' });
    }
    if (state.calibrating) return json(res, 200, { ok: true, alreadyRunning: true });
    state.calibrating = true;
    log('开始跑校准（老师模型转写 + 生成建议）…');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'calibrate.cjs')], {
      windowsHide: true, stdio: 'ignore',
    });
    child.on('exit', (code) => {
      state.calibrating = false;
      log('校准结束（exit ' + code + '），建议已写入 capture/suggestions.json');
    });
    return json(res, 200, { ok: true, started: true });
  }

  if (p === '/api/calibrate/adopt' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const store = require('../src/store.js');
    const kind = String(body.type || '');
    const word = String(body.word || '');
    const variant = String(body.variant || '');
    if (!word) return json(res, 400, { error: 'word required' });
    if (kind === 'add') {
      if (!variant) return json(res, 400, { error: 'variant required' });
      const primary = planner.lookup(word);
      if (!primary) return json(res, 400, { error: '没有这个词: ' + word });
      const out = planner.bind(variant, primary.plan, { model: 'calibrator', kind: 'synonym', aliasOf: word });
      if (out.ok) rebuildSpotter();
      log('采纳建议：把「' + variant + '」加成「' + word + '」的同义词');
      return json(res, 200, out);
    }
    if (kind === 'remove') {
      const ok = planner.remove(word);
      if (ok) rebuildSpotter();
      log('采纳建议：删除同义词「' + word + '」');
      return json(res, 200, { ok });
    }
    return json(res, 400, { error: 'type 必须是 add 或 remove' });
  }

  if (p === '/api/calibrate/start' && req.method === 'POST') {
      if (state.calibrating) return json(res, 409, { ok: false, error: '正在校准中' });
      const entries = capture.list();
      if (!entries.length) return json(res, 400, { ok: false, error: '还没有采集到录音' });
      state.calibrating = true;
      state.calibrateProgress = { done: 0, total: entries.length };
      void (async () => {
        try {
          const files = entries.map((e) => path.join(capture.dir, e.file));
          const out = await teacher.transcribeMany(files, (done, total) => {
            state.calibrateProgress = { done, total };
          });
          if (!out.ok) {
            state.lastReport = { error: out.error, at: new Date().toISOString() };
            log('校准失败: ' + out.error);
            return;
          }
          const words = state.words.map((w) => ({ word: w.word, planKey: w.planKey }));
          const report = buildReport(entries, out.results, words, matchThreshold());
          report.matchThreshold = matchThreshold();
          report.loadMs = out.loadMs;
          report.transcribeMs = out.ms;
          report.modelPath = out.modelPath;
          state.lastReport = report;
          capture.setReport(report);
          // 结算评分：真真 +1/+1、误触发只加分母、漏检扣分子（用户定的账本规则）
          try {
            const entryById = new Map(entries.map((e) => [e.id, e]));
            const before = ledger.load(capture.dir);
            const settled = ledger.apply(before, report.rows, entryById);
            if (settled.counted) {
              report.score = ledger.summary(settled.ledger);
              report.scoreDelta = settled.delta;
              ledger.save(capture.dir, settled.ledger);
              // counted 标记写回索引，避免下次重复结算
              fs.writeFileSync(path.join(capture.dir, 'index.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
              const s = report.score;
              log('评分：本批 ' + settled.counted + ' 段（真真 ' + settled.delta.tp + ' / 误触发 ' + settled.delta.fp + ' / 漏检 ' + settled.delta.fn + '）→ 累计 ' + s.numerator + '/' + s.denominator + (s.percent == null ? '' : ' = ' + s.percent + '%'));
              capture.reload();
            }
          } catch (e) { log('评分结算失败: ' + e.message); }
          // 复核之后立刻清洗：双方都判"假"的样本对改进没有信息量，删掉（用户定的规则）
          try {
            const dedup = curate({
              dir: capture.dir,
              entries,
              report,
              keepNegatives: Number(process.env.VK_KEEP_NEGATIVES || 0),
            });
            if (dedup.removedEntries) {
              log('数据集清洗：删掉 ' + dedup.removedEntries + ' 条"双方都不认为是命令"的录音，剩 ' + dedup.remaining + ' 条');
              capture.reload();
            }
          } catch (e) { log('清洗失败: ' + e.message); }
          try {
            fs.writeFileSync(path.join(capture.dir, 'report.json'), JSON.stringify(report, null, 2));
          } catch { /* ignore */ }
          log(`校准完成：${report.summary.total} 段，漏检 ${report.summary.falseNegative}，误触发 ${report.summary.falsePositive}，用时 ${out.ms}ms`);
        } catch (e) {
          state.lastReport = { error: String(e && e.message), at: new Date().toISOString() };
          log('校准异常: ' + e.message);
        } finally {
          state.calibrating = false;
          state.calibrateProgress = null;
        }
      })();
      return json(res, 200, { ok: true, started: true, total: entries.length });
    }

    // ---- 快照 / 恢复（L2/L3 允许任意改代码，靠这个兜底）
    if (p === '/api/snapshots') {
      try {
        const { execFileSync } = require('node:child_process');
        const OUT = execFileSync('git', ['-C', path.resolve(__dirname, '..'), 'log', '--pretty=%H%x09%ad%x09%s', '--date=format:%m-%d %H:%M', '-n', '12'], { encoding: 'utf8', windowsHide: true });
        const items = OUT.trim().split('\n').filter(Boolean).map((l) => {
          const [sha, when, ...rest] = l.split('\t');
          return { sha, when, subject: rest.join(' ') };
        });
        return json(res, 200, { snapshots: items });
      } catch (e) {
        return json(res, 200, { snapshots: [], error: e.message });
      }
    }
    if (p === '/api/snapshot' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const msg = (body.message || 'manual snapshot').slice(0, 120);
      try {
        const { execFileSync } = require('node:child_process');
        const repo = path.resolve(__dirname, '..');
        execFileSync('git', ['-C', repo, 'add', '-A'], { windowsHide: true });
        execFileSync('git', ['-C', repo, 'commit', '-m', msg, '--allow-empty'], { windowsHide: true });
        const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
        pushEvent({ type: 'snapshot', reason: msg });
        return json(res, 200, { ok: true, sha, message: msg });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message).split('\n')[0] });
      }
    }
    if (p === '/api/restore' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!/^[0-9a-f]{7,40}$/.test(body.sha || '')) return json(res, 400, { ok: false, error: 'sha 不合法' });
      const { execFileSync } = require('node:child_process');
      const repo = path.resolve(__dirname, '..');
      // 先确认这个提交真的存在，再动 git；否则会把用户当前的改动白白塞进 stash
      try {
        execFileSync('git', ['-C', repo, 'rev-parse', '--verify', body.sha + '^{commit}'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        return json(res, 400, { ok: false, error: '这个快照不存在（可能已被清理）' });
      }
      try {
        execFileSync('git', ['-C', repo, 'stash', '--include-untracked', '-m', 'before-restore'], { windowsHide: true });
        execFileSync('git', ['-C', repo, 'reset', '--hard', body.sha], { windowsHide: true });
        pushEvent({ type: 'restore', reason: '恢复到 ' + body.sha.slice(0, 8) });
        return json(res, 200, { ok: true, restored: body.sha, note: '已恢复，改动存进 git stash（git stash pop 可找回）' });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message).split('\n')[0] });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('HTTP 失败: ' + e.message);
    json(res, 500, { error: e.message });
  }
});

// 被壳（将来的 exe）以管道方式启动时，父进程一死就退出，别留孤儿进程
if (process.env.VK_PARENT_WATCH === '1') {
  process.stdin.on('end', () => { log('父进程已退出'); process.exit(0); });
  process.stdin.on('close', () => { log('父进程已退出'); process.exit(0); });
  process.stdin.resume();
}

function shutdown() {
  state.shuttingDown = true;
  stopLoop();
  if (asrProc) { try { asrProc.stdin.write(JSON.stringify({ type: 'quit' }) + '\n'); } catch { /* ignore */ } try { asrProc.kill(); } catch { /* ignore */ } }
  executor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
// 后台任务（校准、快照）里的异常不应该把语音服务带崩：记录并继续
process.on('unhandledRejection', (e) => {
  log('未处理的异步错误: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
});

// 未捕获的同步异常默认会让进程直接退出、日志里什么都看不到（2026-11-16 夜里就是这么没的）。
// 记下来，尽量活下去；真到了无法继续也只能重启，但至少知道死因。
process.on('uncaughtException', (e) => {
  log('未捕获异常: ' + String((e && e.stack) || e).split('\\n').slice(0, 4).join(' | '));
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 启动自检：把"启动后才发现"的问题提前暴露（算法载入失败、模型缺失、计划不完整等）
try {
  const sc = require('./selfcheck.js').run({ port: PORT, listening: true });
  if (sc.ok) log('自检通过：' + sc.checks.length + ' 项');
  else log('自检发现问题：' + sc.failed.join(' / '));
} catch (e) { log('自检本身出错: ' + (e && e.message)); }

server.listen(PORT, '127.0.0.1', () => {
  log(`VoiceKeys APP: http://127.0.0.1:${PORT}/`);
  if (OPEN_BROWSER) {
    try {
      require('node:child_process')
        .spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${PORT}/`], { detached: true, stdio: 'ignore', windowsHide: true })
        .unref();
    } catch { /* 浏览器打不开不影响服务 */ }
  }
  trigger = new Trigger({
    words: [],

    pauseMs: PAUSE_MS,
    onFire: (w) => { void fireWord(w); },

    onEvent: (e) => pushEvent(e),
  });
  rebuildSpotter();
  startAsrWorker();
  startHandyWatcher();

  void startLoop();
});
