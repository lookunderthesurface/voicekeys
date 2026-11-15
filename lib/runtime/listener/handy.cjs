// 让 Handy 开始/停止录音，并能观测它「到底在不在录」。
//
// Handy 0.10 只提供 toggle（开关），没有查询状态的接口。而用户随时可能在 Handy 的
// 悬浮窗上点 X 取消录音——那时我们的状态就和它对不上了，下一次 toggle 会反向：
// 说「over」反而开始录音。所以这里用 Windows 自己的麦克风占用记录当观测点：
//   HKCU\...\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\<exe 用 # 分隔>
//   LastUsedTimeStart > LastUsedTimeStop  ⇔  该进程此刻正在用麦克风。
const path = require('node:path');
const { spawn, spawnSync, execFile } = require('node:child_process');

const DEFAULT_HANDY = path.join(process.env.LOCALAPPDATA || '', 'Handy', 'handy.exe');
// 允许运行时改路径：设置里配了 handyPath 就写进 process.env.HANDY_EXE
function resolveExe() {
  return process.env.HANDY_EXE || DEFAULT_HANDY;
}
const HANDY_EXE = DEFAULT_HANDY;

const MIC_ROOT =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged';

/** Registry value name Windows uses for a given executable path. */
function micKeyName(exePath) {
  return String(exePath).replace(/\\/g, '#');
}

/** 解析 reg query 的输出，供同步/异步两条路复用。 */
function parseRecording(stdout) {
  const start = /LastUsedTimeStart\s+REG_QWORD\s+0x([0-9a-fA-F]+)/.exec(stdout || '');
  if (!start) return null;
  const stop = /LastUsedTimeStop\s+REG_QWORD\s+0x([0-9a-fA-F]+)/.exec(stdout || '');
  const startValue = BigInt('0x' + start[1]);
  const stopValue = stop ? BigInt('0x' + stop[1]) : 0n;
  return startValue > stopValue;
}

/**
 * 观测：Handy 当前是否正在录音。
 *
 * 返回 true / false，无法判断时返回 null（调用方应退回"相信自己的状态"）。
 */
function isRecording(exePath = resolveExe()) {
  try {
    const key = `${MIC_ROOT}\\${micKeyName(exePath)}`;
    const out = spawnSync('reg.exe', ['query', key], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
    });
    if (out.status !== 0) return null;
    return parseRecording(out.stdout);
  } catch {
    return null;
  }
}

/** 非阻塞版：给周期性校准用，避免在音频循环里卡 40ms。 */
function isRecordingAsync(callback, exePath = resolveExe()) {
  try {
    const key = `${MIC_ROOT}\\${micKeyName(exePath)}`;
    execFile('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 2000 }, (err, stdout) => {
      callback(err ? null : parseRecording(stdout));
    });
  } catch {
    callback(null);
  }
}

/** Returns false when the executable is missing; the caller logs that once. */
function toggleTranscription() {
    const exe = resolveExe();
  try {
    // A .cmd/.bat cannot be spawned directly on Windows, so route it through cmd.exe.
    const isScript = /[.](cmd|bat)$/i.test(resolveExe());
    const child = isScript
      ? spawn('cmd.exe', ['/c', exe, '--toggle-transcription'], { stdio: 'ignore', windowsHide: true, detached: true })
      : spawn(exe, ['--toggle-transcription'], { stdio: 'ignore', windowsHide: true, detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { toggleTranscription, isRecording, isRecordingAsync, HANDY_EXE, resolveExe };
