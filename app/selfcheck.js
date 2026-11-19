// 启动自检：把"启动后才发现坏了"的东西提前查一遍
//
// 为什么要有：最近连续出现三类事故——算法模块未定义导致进程崩、GUI 脚本中断导致永远"连接中"、
// 模型文件缺失导致 ASR 起不来。这些都能在启动时 1 秒内查出来，不该等用户发现。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = require('./config.js').DIRS.root;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/**
 * @param {object} deps 由 server 注入：端口、词表、算法状态、采集、模型路径
 */
function run(deps = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

  // 1. 计划库
  try {
    const store = require('../src/store.js');
    const list = store.list();
    add('计划库可读', true, list.length + ' 个词');
  } catch (e) {
    add('计划库可读', false, String(e && e.message));
  }

  // 2. 算法模块
  try {
    const algo = require('./algorithms');
    const roles = Object.keys(algo.status || {});
    const broken = roles.filter((r) => algo.status[r].error);
    add('算法模块', broken.length === 0, broken.length ? '有错误: ' + broken.join(',') : roles.join(' / '));
  } catch (e) {
    add('算法模块', false, String(e && e.message));
  }

  // 3. 模型文件
  const asr = path.join(BASE, 'models', 'asr');
  const m1 = path.join(asr, 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30', 'encoder.int8.onnx');
  const m2 = path.join(asr, 'sherpa-onnx-paraformer-zh-small-2024-03-09', 'model.int8.onnx');
  add('M1 模型文件', exists(m1), m1);
  add('M2 模型文件', exists(m2), m2);

  // 4. 老师模型（可选，缺了只是没法校准）
  try {
    const t = require('./teacher.js').modelInfo();
    add('老师模型（可选）', t.found, t.path || '未找到');
  } catch (e) {
    add('老师模型（可选）', false, String(e && e.message));
  }

  // 5. 采集目录可写
  try {
    const cap = path.join(BASE, 'capture');
    fs.mkdirSync(cap, { recursive: true });
    fs.accessSync(cap, fs.constants.W_OK);
    const n = fs.existsSync(path.join(cap, 'index.jsonl'))
      ? fs.readFileSync(path.join(cap, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    add('采集目录可写', true, n + ' 条素材');
  } catch (e) {
    add('采集目录可写', false, String(e && e.message));
  }

  // 6. 词表里每个词都必须有可执行计划
  try {
    const planner = require('./planner.js');
    const bad = planner.listVerbose().filter((w) => !(w.plan && w.plan.steps && w.plan.steps.length));
    add('词表计划完整', bad.length === 0, bad.length ? '缺计划: ' + bad.map((w) => w.say).join(',') : '全部有计划');
  } catch (e) {
    add('词表计划完整', false, String(e && e.message));
  }

  // 7. 执行器 worker 脚本存在
  add('执行器脚本', exists(path.join(ROOT, 'runtime', 'worker.ps1')), 'runtime/worker.ps1');

  // 8. 端口已监听（server 注入）
  if (deps.port) add('HTTP 端口', Boolean(deps.listening), ':' + deps.port);

  const failed = checks.filter((c) => !c.ok);
  return { at: new Date().toISOString(), ok: failed.length === 0, checks, failed: failed.map((c) => c.name) };
}

module.exports = { run };
