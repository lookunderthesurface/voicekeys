// 原语表 + 计划校验 + 执行器 + 自定义动作入口。
//
// 设计边界（对应产品承诺）：
//   · 这里只放「可逆、无持久副作用、参数有界」的原语，AI 只能组合它们；
//   · AI 产出的是一份 JSON 计划，不是代码 —— 所以不需要沙箱；
//   · 用户要更强的东西就走 custom/ 目录，我们不校验、不沙箱、不背书。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'runtime', 'worker.ps1');
const CUSTOM_DIR = process.env.VOICEKEYS_CUSTOM || path.join(ROOT, 'custom');
// 哪些窗口算"播放器"（用于切前台按空格）
const MEDIA_WINDOWS =
  process.env.VOICEKEYS_MEDIA_WINDOWS || 'QyWindow|爱奇艺|哔哩哔哩|bilibili|YouTube|PotPlayer|VLC';

// ---------------------------------------------------------------- 原语表

/**
 * 每个原语声明：参数范围、是否可逆、风险级别、对应的 worker 命令。
 * `kind: 'flow'` 是流程控制（不直接调 worker），其余是系统动作。
 */
const PRIMITIVES = [
  {
    id: 'audio.volume.set',
    kind: 'system',
    desc: '把系统音量设到指定百分比',
    params: { percent: { min: 0, max: 100, default: 50 } },
    reversible: true,
    risk: 'safe',
    toWorker: (p) => ({ op: 'audio.set', value: p.percent / 100 }),
  },
  {
    id: 'audio.volume.delta',
    kind: 'system',
    desc: '在当前音量基础上增减（正数变大，负数变小）',
    params: {
      percent: { min: -100, max: 100, default: 10 },
      // api = 精确写入（无声）；key = 一直按音量键；hybrid = API 精确到位 + 一次按键触发系统音量条
      mode: { enum: ['api', 'key', 'hybrid'], default: 'hybrid' },
    },
    reversible: true,
    risk: 'safe',
    async run(p, ctx) {
      if (p.mode === 'key') {
        const steps = Math.max(1, Math.min(50, Math.round(Math.abs(p.percent) / 2)));
        const key = p.percent >= 0 ? 'volume_up' : 'volume_down';
        let last = null;
        for (let i = 0; i < steps; i += 1) {
          last = await ctx.call({ op: 'key.press', key });
          await ctx.call({ op: 'wait', ms: 90 });
        }
        return last || { ok: true };
      }
      const cur = await ctx.call({ op: 'audio.get' });
      const target = Math.max(0, Math.min(100, Math.round(cur.volume * 100 + p.percent)));

      if (p.mode === 'hybrid') {
        // API 把值放到"目标 ±2"，再按一次音量键走到目标：精确 + 系统音量条
        if (target <= 98) {
          await ctx.call({ op: 'audio.set', value: (target + 2) / 100 });
          await ctx.call({ op: 'key.press', key: 'volume_down' });
        } else if (target >= 2) {
          await ctx.call({ op: 'audio.set', value: (target - 2) / 100 });
          await ctx.call({ op: 'key.press', key: 'volume_up' });
        } else {
          await ctx.call({ op: 'audio.set', value: target / 100 });
          await ctx.call({ op: 'key.press', key: 'volume_down' });
        }
        const after = await ctx.call({ op: 'audio.get' });
        return { ok: true, volume: after.volume };
      }

      return ctx.call({ op: 'audio.set', value: target / 100 });
    },
  },
  {
    id: 'audio.mute.toggle',
    kind: 'system',
    desc: '切换静音状态',
    params: {},
    reversible: true,
    risk: 'safe',
    toWorker: () => ({ op: 'audio.mute', toggle: true }),
  },
  {
    id: 'audio.mute.set',
    kind: 'system',
    desc: '把静音设为指定状态（true=静音，false=取消静音）',
    params: { value: { enum: [true, false], default: true } },
    reversible: true,
    risk: 'safe',
    toWorker: (p) => ({ op: 'audio.mute', value: p.value }),
  },
  {
    id: 'display.brightness.set',
    kind: 'system',
    desc: '把内置屏幕亮度设到指定百分比（下限 5，避免全黑）',
    params: { percent: { min: 5, max: 100, default: 60 } },
    reversible: true,
    risk: 'safe',
    note: '仅内置屏；台式显示器不支持',
    toWorker: (p) => ({ op: 'display.set', value: p.percent }),
  },
  {
    id: 'display.brightness.delta',
    kind: 'system',
    desc: '在当前亮度基础上增减',
    params: { percent: { min: -95, max: 95, default: 10 } },
    reversible: true,
    risk: 'safe',
    async run(p, ctx) {
      const cur = await ctx.call({ op: 'display.get' });
      if (!cur || !cur.ok) return cur || { ok: false, error: 'display unavailable' };
      const next = Math.max(5, Math.min(100, cur.brightness + p.percent));
      return ctx.call({ op: 'display.set', value: next });
    },
  },
  {
    id: 'key.press',
    kind: 'system',
    desc: '按一个键（只允许白名单里的键）',
    params: {
      key: {
        enum: [
          'space',
          'enter',
          'esc',
          'up',
          'down',
          'left',
          'right',
          'media_play_pause',
          'media_next',
          'media_prev',
          'media_stop',
          'volume_up',
          'volume_down',
          'volume_mute',
        ],
        default: 'space',
      },
    },
    reversible: true,
    risk: 'safe',
    note: '部分全屏独占程序收不到合成按键',
    toWorker: (p) => ({ op: 'key.press', key: p.key }),
  },
  {
    id: 'media.toggle',
    kind: 'system',
    desc: '控制播放器：把它的窗口切到前台按空格。暂停时还原焦点，播放时留在前台',
    params: {
      action: { enum: ['toggle', 'pause', 'play'], default: 'toggle' },
      app: { type: 'string', maxLength: 40, default: '' },
      restoreFocus: { type: 'boolean', default: true },
    },
    reversible: true,
    risk: 'safe',
    async run(p, ctx) {
      // 窗口定位/激活都走常驻 worker（不再为每次操作新起 PowerShell，省 ~400ms）
      const pattern = p.app ? p.app : MEDIA_WINDOWS;
      const found = await ctx.call({ op: 'window.find', match: pattern }, 4000);
      if (!found || !found.ok) return { ok: false, error: 'no player window matched', pattern };

      let act = await ctx.call({ op: 'window.activate', hwnd: found.hwnd }, 4000);
      // Windows 会拒绝后台进程切前台（SetForegroundWindow 受限）。没切过去还按空格的话，
      // 空格会打到"当前前台"窗口——用户遇到的就是这个（说暂停视频却动了 DSH）。
      if (!act || act.foreground !== found.hwnd) {
        await ctx.call({ op: 'wait', ms: 120 });
        act = await ctx.call({ op: 'window.activate', hwnd: found.hwnd }, 4000);
      }
      if (!act || act.foreground !== found.hwnd) {
        return {
          ok: false,
          error: '无法把播放器切到前台，已取消按键（避免空格打到别的窗口）',
          window: found.title,
          foreground: act ? act.foreground : 0,
        };
      }
      await ctx.call({ op: 'key.press', key: 'space' });
      await ctx.call({ op: 'wait', ms: 50 });

      // 暂停：把焦点还给原来的窗口；播放：留在前台
      let restored = false;
      const prev = act && act.prev ? act.prev : 0;
      const shouldRestore = p.restoreFocus && p.action !== 'play' && prev && prev !== found.hwnd;
      if (shouldRestore) {
        const back = await ctx.call({ op: 'window.restore', hwnd: prev }, 4000);
        restored = Boolean(back && back.ok);
      }

      return {
        ok: true,
        action: p.action,
        window: found.title,
        activated: Boolean(act && act.foreground === found.hwnd),
        restored,
        note: '已对「' + found.title + '」按空格' + (restored ? '，焦点已还原' : '，焦点留在前台'),
      };
    },
  },
  {
    id: 'handy.set',
    kind: 'system',
    desc: 'Handy 语音听写：on=开始录音，off=停止录音，toggle=切换（幂等，已是目标状态就不动）',
    params: { target: { enum: ['on', 'off', 'toggle'], default: 'toggle' } },
    reversible: true,
    risk: 'safe',
    async run(p) {
      const path = require('node:path');
      // 走应用自带 lib（app/paths.js 解析）；旧代码硬编码 ../../voice-plugin，自包含改造后那个目录不存在了
      const paths = require('../app/paths.js');
      const handy = require(path.join(paths.pluginRoot(), 'runtime', 'listener', 'handy.cjs'));
      const busy = handy.isRecording();
      const want = p.target === 'toggle' ? !busy : p.target === 'on';
      if (busy === want) {
        return { ok: true, changed: false, recording: busy, note: want ? 'Handy 已经在录音' : 'Handy 本来就没在录' };
      }
      handy.toggleTranscription();
      return { ok: true, changed: true, recording: want, note: want ? '已开始 Handy 录音' : '已停止 Handy 录音' };
    },
  },
  {
    id: 'flow.wait',
    kind: 'flow',
    desc: '等待若干毫秒',
    params: { ms: { min: 0, max: 5000, default: 300 } },
    reversible: true,
    risk: 'safe',
    toWorker: (p) => ({ op: 'wait', ms: p.ms }),
  },
  {
    id: 'flow.repeat',
    kind: 'flow',
    desc: '把一组步骤重复 N 次',
    params: { times: { min: 1, max: 50, default: 2 }, body: { type: 'steps' } },
    reversible: true,
    risk: 'safe',
  },
  {
    id: 'flow.if',
    kind: 'flow',
    desc: '按当前状态判断（muted / volume_lt / brightness_lt）',
    params: {
      when: { enum: ['muted', 'not_muted', 'volume_lt', 'brightness_lt'], default: 'muted' },
      value: { min: 0, max: 100, default: 50 },
      body: { type: 'steps' },
    },
    reversible: true,
    risk: 'safe',
  },
];

const BY_ID = new Map(PRIMITIVES.map((p) => [p.id, p]));

/** 给模型看的「函数库说明」——由原语表自动生成，永远不会和实现漂移。 */
function primitiveCatalog() {
  return PRIMITIVES.map((p) => ({
    id: p.id,
    desc: p.desc,
    params: Object.fromEntries(
      Object.entries(p.params).map(([k, v]) => [
        k,
        v.enum
          ? `enum(${v.enum.join('|')})`
          : v.type === 'steps'
            ? 'steps[]'
            : v.type === 'string'
              ? `string(<=${v.maxLength})`
              : v.type === 'boolean'
                ? 'bool'
                : `${v.min}..${v.max}`,
      ]),
    ),
    ...(p.note ? { note: p.note } : {}),
  }));
}

// ---------------------------------------------------------------- 计划校验

const LIMITS = {
  maxSteps: 32,
  maxDepth: 3,
  maxWaitMs: 10000,
  maxTotalMs: 15000,
  maxRepeat: 50,
};

/** @returns {{ok:boolean, plan?:object, errors:string[], warnings:string[]}} */
function validatePlan(plan) {
  const errors = [];
  const warnings = [];
  let steps = 0;
  let waitMs = 0;

  const clamp = (p, spec) => {
    if (spec.enum) {
      if (p === undefined) return spec.default !== undefined ? spec.default : spec.enum[0];
      if (!spec.enum.includes(p)) throw new Error(`值 ${p} 不在允许范围（${spec.enum.join('/')}）`);
      return p;
    }
    if (spec.type === 'boolean') {
      if (p === undefined) return spec.default !== undefined ? spec.default : false;
      if (typeof p === 'boolean') return p;
      return p === 1 || p === 'true' || p === '1';
    }
    if (spec.type === 'string') {
      const s = String(p ?? spec.default ?? '');
      return s.slice(0, spec.maxLength ?? 200);
    }
    const n = Number(p ?? spec.default ?? 0);
    if (!Number.isFinite(n)) throw new Error('参数不是数字');
    if (n < spec.min || n > spec.max) {
      warnings.push(`参数 ${n} 超出 ${spec.min}..${spec.max}，已钳制`);
      return Math.max(spec.min, Math.min(spec.max, n));
    }
    return n;
  };

  const walk = (list, depth) => {
    if (!Array.isArray(list)) throw new Error('steps 必须是数组');
    if (depth > LIMITS.maxDepth) throw new Error('嵌套太深');
    return list.map((step) => {
      steps += 1;
      if (steps > LIMITS.maxSteps) throw new Error(`步骤超过 ${LIMITS.maxSteps} 步`);
      const prim = BY_ID.get(step && step.op);
      if (!prim) {
        // 自定义动作（custom/*.json）也算合法动作，args 原样透传
        const op = String((step && step.op) || "");
        if (op.startsWith("custom.")) {
          const found = listCustomActions().find((c) => c.id === op);
          if (!found) throw new Error(`未找到自定义动作：${op}`);
          if (found.error) throw new Error(`自定义动作 ${op} 定义有问题：${found.error}`);
          return { op, args: (step && step.args) || {} };
        }
        throw new Error(`未知动作：${op}`);
      }
      const params = {};
      for (const [key, spec] of Object.entries(prim.params)) {
        if (spec.type === 'steps') continue;
        params[key] = clamp(step[key], spec);
      }
      if (prim.id === 'flow.wait') waitMs += params.ms;
      if (prim.id === 'flow.repeat') {
        params.times = Math.min(LIMITS.maxRepeat, Math.max(1, params.times));
        params.body = walk(step.body, depth + 1);
      }
      if (prim.id === 'flow.if') {
        params.body = walk(step.body, depth + 1);
      }
      return { op: prim.id, ...params };
    });
  };

  try {
    const normalized = walk(plan && plan.steps, 0);
    if (waitMs > LIMITS.maxWaitMs) errors.push(`总等待 ${waitMs}ms 超过上限 ${LIMITS.maxWaitMs}ms`);
    return { ok: errors.length === 0, plan: { ...plan, steps: normalized }, errors, warnings };
  } catch (e) {
    errors.push(e.message);
    return { ok: false, errors, warnings };
  }
}

// ---------------------------------------------------------------- worker 客户端

class Worker {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.pending = [];
    this.ready = false;
  }

  start() {
    if (this.child) return;
    this.child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write('[worker] ' + text + '\n');
    });
    this.child.on('exit', () => {
      this.child = null;
      this.ready = false;
      while (this.pending.length) this.pending.shift()(new Error('worker exited'));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.ready) {
        this.ready = true;
        continue;
      }
      const resolve = this.pending.shift();
      if (resolve) resolve(msg);
    }
  }

  call(cmd, timeoutMs = 5000) {
    this.start();
    return new Promise((resolve) => {
      if (!this.child) return resolve({ ok: false, error: 'worker not running' });
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(wrap);
        if (i >= 0) this.pending.splice(i, 1);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      const wrap = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.pending.push(wrap);
      try {
        this.child.stdin.write(JSON.stringify(cmd) + '\n');
      } catch {
        const i = this.pending.indexOf(wrap);
        if (i >= 0) this.pending.splice(i, 1);
        clearTimeout(timer);
        resolve({ ok: false, error: 'write failed' });
      }
    });
  }

  stop() {
    if (this.child) {
      try { this.child.stdin.end(); } catch { /* gone */ }
      try { this.child.kill(); } catch { /* gone */ }
      this.child = null;
    }
  }
}

// ---------------------------------------------------------------- 执行器

const RATE = { perOpMs: 1000, globalPerMin: 30 };
const lastOpAt = new Map();
const recent = [];

async function execute(plan, { worker, now = () => Date.now(), onStep = () => {} } = {}) {
  const w = worker || new Worker();
  const results = [];
  const ctx = { call: (cmd) => w.call(cmd) };

  const rateCheck = (op) => {
    const t = now();
    const last = lastOpAt.get(op) || 0;
    if (t - last < RATE.perOpMs) return `动作太频繁：${op}（1 秒内只能一次）`;
    const recentHit = recent.filter((x) => t - x < 60000).length;
    if (recentHit >= RATE.globalPerMin) return '每分钟动作次数已达上限';
    lastOpAt.set(op, t);
    recent.push(t);
    return null;
  };

  const runSteps = async (steps, depth = 0) => {
    if (depth > LIMITS.maxDepth) return;
    for (const step of steps) {
      const prim = BY_ID.get(step.op);
      const blocked = rateCheck(step.op);
      if (blocked) {
        results.push({ op: step.op, ok: false, error: blocked });
        onStep(results[results.length - 1]);
        continue;
      }
      if (step.op === 'flow.repeat') {
        for (let i = 0; i < step.times; i += 1) await runSteps(step.body, depth + 1);
        continue;
      }
      if (step.op === 'flow.if') {
        let truthy = false;
        if (step.when === 'muted' || step.when === 'not_muted') {
          const cur = await ctx.call({ op: 'audio.get' });
          truthy = step.when === 'muted' ? Boolean(cur.muted) : !cur.muted;
        } else if (step.when === 'volume_lt') {
          const cur = await ctx.call({ op: 'audio.get' });
          truthy = cur.volume * 100 < step.value;
        } else if (step.when === 'brightness_lt') {
          const cur = await ctx.call({ op: 'display.get' });
          truthy = cur.brightness < step.value;
        }
        if (truthy) await runSteps(step.body, depth + 1);
        continue;
      }
      let out;
      try {
        if (!prim) {
          const meta = listCustomActions().find((c) => c.id === step.op);
          if (!meta) throw new Error(`未找到自定义动作：${step.op}`);
          out = await runCustomAction(meta, step.args || {}, meta.timeoutMs || 5000);
        } else {
          out = prim.run ? await prim.run(step, ctx) : await ctx.call(prim.toWorker(step));
        }
      } catch (e) {
        out = { ok: false, error: String(e && e.message) };
      }
      results.push({ op: step.op, ...out });
      onStep(results[results.length - 1]);
    }
  };

  const t0 = now();
  await runSteps(plan.steps);
  return { results, elapsedMs: now() - t0 };
}

// ---------------------------------------------------------------- 自定义动作（用户的地盘）

/**
 * custom/<name>.json 声明一个动作：
 *   { "id":"custom.open-browser", "desc":"...", "params":{"url":"string"}, "exec":"open-browser.cmd", "timeoutMs":5000 }
 * 我们只负责：传参（JSON 到 stdin）→ 执行 → 读 stdout。不校验、不沙箱、不背书。
 */
function listCustomActions() {
  const out = [];
  if (!fs.existsSync(CUSTOM_DIR)) return out;
  for (const file of fs.readdirSync(CUSTOM_DIR, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    try {
      const meta = require('./util').readJson(path.join(CUSTOM_DIR, file.name));
      if (!meta || !meta.id || !meta.exec) continue;
      out.push({ ...meta, file: file.name, risk: 'user' });
    } catch {
      out.push({ id: file.name, risk: 'user', error: 'invalid json' });
    }
  }
  return out;
}

function runCustomAction(meta, params, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const execPath = path.resolve(CUSTOM_DIR, meta.exec);
    if (!fs.existsSync(execPath)) {
      resolve({ ok: false, error: `missing executable: ${meta.exec}` });
      return;
    }
    const isScript = /\.(cmd|bat)$/i.test(execPath);
    const child = spawn(
      isScript ? process.env.ComSpec || 'cmd.exe' : execPath,
      isScript ? ['/c', execPath] : [],
      { cwd: CUSTOM_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve({ ok: false, error: 'custom action timeout' });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 1024) });
    });
    try {
      child.stdin.end(JSON.stringify(params || {}));
    } catch {
      /* stdin already closed */
    }
  });
}

module.exports = {
  PRIMITIVES,
  BY_ID,
  primitiveCatalog,
  validatePlan,
  Worker,
  execute,
  LIMITS,
  listCustomActions,
  runCustomAction,
  CUSTOM_DIR,
  MEDIA_WINDOWS,
};
