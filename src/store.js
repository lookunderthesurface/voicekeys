// 计划缓存：把「一句需求 -> 一份计划」的结果落盘。
//
// 这是原型的核心用法：**唤醒词只负责触发，计划是提前生成好、绑好关键词的**。
// 所以生成慢一点完全没关系（9B 一秒多），运行时是零模型开销。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STORE = process.env.VOICEKEYS_PLANS || require('../app/config.js').FILES.plans;

/** 归一化：去空白/标点，便于"音量调到四十"和"音量调到四十。"命中同一条。 */
function normalize(text) {
  return String(text || '')
    .replace(/[\s，。、！？,.!?~～]/g, '')
    .toLowerCase();
}

function load() {
  try {
    return require('./util').readJson(STORE, {});
  } catch {
    return {};
  }
}

function save(data) {
  // 先写临时文件再改名：直接覆盖写，一旦进程在写一半时被杀（或断电），
  // plans.json 就变成不完整的 JSON，所有绑定一起丢失。改名在同一分区上是原子的。
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, STORE);
}

/** @returns {{ok:boolean, entry?:object, error?:string}} */
function bind(phrase, plan, meta = {}) {
  const key = normalize(phrase);
  if (!key) return { ok: false, error: 'empty phrase' };
  const data = load();
  data[key] = {
    say: String(phrase).trim(),
    plan,
    model: meta.model || '',
    // 每个词可以有自己的等待时间：唤醒词要立刻响（0ms），结束词稍等（600ms）
    pauseMs: typeof meta.pauseMs === 'number' ? meta.pauseMs : 1000,
    // 是否跳过"首部门"：唤醒/结束词本来就出现在连续说话里
    noLead: Boolean(meta.noLead),
    boundAt: new Date().toISOString(),
  };
  save(data);
  return { ok: true, entry: data[key] };
}

function lookup(phrase) {
  const data = load();
  return data[normalize(phrase)] || null;
}

function list() {
  const data = load();
  return Object.entries(data).map(([key, v]) => ({ key, say: v.say, steps: (v.plan && v.plan.steps || []).length, model: v.model, boundAt: v.boundAt }));
}

function remove(phrase) {
  const key = normalize(phrase);
  const data = load();
  if (!data[key]) return false;
  delete data[key];
  save(data);
  return true;
}

/** 单独设置某个词的静音门毫秒数（0~5000） */
function setGate(word, pauseMs) {
  const data = load();
  const entry = data[normalize(word)];
  if (!entry) return { ok: false, error: '没有这个词: ' + word };
  const ms = Math.max(0, Math.min(5000, Math.round(Number(pauseMs))));
  entry.pauseMs = ms;
  save(data);
  return { ok: true, word, pauseMs: ms };
}

/** 设置某个词的 M1 / M2 阈值（null = 用全局默认） */
function setThresholds(word, thresholds = {}) {
  const data = load();
  const entry = data[normalize(word)];
  if (!entry) return { ok: false, error: '没有这个词: ' + word };
  const clamp = (v) => (v == null || v === '' ? null : Math.max(0, Math.min(1, Number(v))));
  entry.thresholds = { m1: clamp(thresholds.m1), m2: clamp(thresholds.m2) };
  save(data);
  return { ok: true, word, thresholds: entry.thresholds };
}

/** 标记主词 / 同义词 */
function setKind(word, { kind = 'primary', aliasOf = '' } = {}) {
  const data = load();
  const entry = data[normalize(word)];
  if (!entry) return { ok: false, error: '没有这个词: ' + word };
  entry.kind = kind === 'synonym' ? 'synonym' : 'primary';
  entry.aliasOf = entry.kind === 'synonym' ? String(aliasOf || '') : '';
  save(data);
  return { ok: true, word, kind: entry.kind, aliasOf: entry.aliasOf };
}

module.exports = { bind, lookup, list, remove, normalize, STORE, setGate, setThresholds, setKind };
