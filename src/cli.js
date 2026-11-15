#!/usr/bin/env node
// VoiceKeys 原型 CLI
//
//   node src/cli.js primitives                列出安全原语
//   node src/cli.js models                    列出本机 Ollama 模型
//   node src/cli.js plan "音量调到四十"         只生成计划（不执行）
//   node src/cli.js run   "音量调到四十"         生成计划 + 校验 + 执行
//   node src/cli.js raw '<json 计划>'           直接执行一份计划
//   node src/cli.js custom                    列出用户自定义动作
//   node src/cli.js call <动作id> '<json 参数>' 直接调一条原语
const { PRIMITIVES, validatePlan, Worker, execute, listCustomActions, runCustomAction } = require('./core');
const { planFromText, listModels, DEFAULT_MODEL } = require('./ai');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const store = require('./store');

// 每条命令的执行结果都记一行，方便排查"喊了但没反应"。
const CMD_LOG = pathMod.join(require('../app/config.js').DIRS.logs, 'command.log');
function logCommand(entry) {
  try {
    fs.mkdirSync(pathMod.dirname(CMD_LOG), { recursive: true });
    fs.appendFileSync(CMD_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* logging is best effort */
  }
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'primitives') {
    print(PRIMITIVES.map((p) => ({ id: p.id, desc: p.desc, params: p.params, risk: p.risk, reversible: p.reversible, note: p.note })));
    return;
  }

  if (cmd === 'models') {
    print(await listModels());
    return;
  }

  if (cmd === 'bind') {
    const text = rest.join(' ');
    if (!text) return print({ ok: false, error: '需要一句需求' });
    const gen = await planFromText(text);
    if (!gen.ok) return print(gen);
    const out = store.bind(text, gen.plan, { model: gen.model });
    print({ ok: out.ok, cached: out.entry, ms: gen.ms, model: gen.model });
    return;
  }

  // 预准备进程：先把活干到"只差最后一下"，然后等父进程发 go / abort。
  // 用法：node src/cli.js pending "<词组>"
  //   stdout 先输出 {"ready":true}，然后读一行 stdin：go=执行，其它=放弃。
  if (cmd === 'pending') {
    const text = rest.join(' ');
    const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
    const entry = store.lookup(text);
    if (!entry) { line({ ready: false, error: '未绑定：' + text }); return; }
    const check = validatePlan(entry.plan);
    if (!check.ok) { line({ ready: false, errors: check.errors }); return; }

    const worker = new Worker();
    await worker.call({ op: 'ping' });          // 预热 PowerShell 执行器
    const warmAt = Date.now();
    line({ ready: true, say: entry.say, steps: check.plan.steps.length });

    // 父进程如果崩了/没发信号，别让这个进程和它的 PowerShell 一直挂着。
    const prewarmTimeout = setTimeout(() => {
      worker.stop();
      line({ aborted: true, reason: 'timeout waiting for go/abort' });
      process.exit(0);
    }, 8000);

    const answer = await new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => {
        buf += c;
        const i = buf.indexOf('\n');
        if (i >= 0) { process.stdin.pause(); resolve(buf.slice(0, i).trim()); }
      });
      process.stdin.on('end', () => resolve('abort'));
    });

    clearTimeout(prewarmTimeout);
    if (answer !== 'go') {
      worker.stop();
      line({ aborted: true, reason: answer || 'abort' });
      setTimeout(() => process.exit(0), 50);
      return;
    }

    const goAt = Date.now();
    const out = await execute(check.plan, { worker });
    worker.stop();
    line({ ok: true, warmupMs: goAt - warmAt, execution: out });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (cmd === 'plans') {
    print(store.list());
    return;
  }

  if (cmd === 'invoke') {
    const text = rest.join(' ');
    const entry = store.lookup(text);
    if (!entry) return print({ ok: false, error: '未绑定：' + text });
    const check = validatePlan(entry.plan);
    if (!check.ok) return print({ ok: false, error: '缓存的计划不合法', errors: check.errors });
    const worker = new Worker();
    const out = await execute(check.plan, { worker });
    worker.stop();
    logCommand({ say: entry.say, plan: check.plan.steps, results: out.results, elapsedMs: out.elapsedMs });
    print({ ok: true, say: entry.say, plan: check.plan, execution: out });
    return;
  }

  if (cmd === 'custom') {
    print(listCustomActions());
    return;
  }

  if (cmd === 'call') {
    const op = rest[0];
    const params = rest[1] ? JSON.parse(rest[1]) : {};
    const check = validatePlan({ steps: [{ op, ...params }] });
    if (!check.ok) return print({ ok: false, errors: check.errors });
    const worker = new Worker();
    const out = await execute(check.plan, { worker });
    worker.stop();
    print(out);
    return;
  }

  if (cmd === 'plan' || cmd === 'run') {
    const text = rest.join(' ');
    if (!text) return print({ ok: false, error: '需要一句需求，例如：音量调到四十' });
    const gen = await planFromText(text);
    if (!gen.ok) return print(gen);
    if (cmd === 'plan') return print(gen);
    const worker = new Worker();
    const out = await execute(gen.plan, { worker, onStep: (s) => console.error('  step ' + JSON.stringify(s)) });
    worker.stop();
    print({ ...gen, execution: out });
    return;
  }

  if (cmd === 'raw') {
    const plan = JSON.parse(rest.join(' '));
    const check = validatePlan(plan);
    if (!check.ok) return print({ ok: false, errors: check.errors });
    const worker = new Worker();
    const out = await execute(check.plan, { worker });
    worker.stop();
    print({ ok: true, plan: check.plan, execution: out });
    return;
  }

  console.log('用法：primitives | models | plan <文本> | run <文本> | raw <json> | call <op> <params> | custom');
  console.log('      bind <文本>（生成并缓存计划） | plans（看缓存） | invoke <文本>（从缓存执行，零模型开销）');
  console.log('默认模型：' + DEFAULT_MODEL);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
