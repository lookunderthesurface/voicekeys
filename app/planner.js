// Planner：一句中文 → 可执行计划；同时管"关键词 → 计划"的绑定表。
// 只依赖 src/ai.js（模型调用）和 src/store.js（plans.json）。
const path = require('node:path');
const { planFromText, listModels } = require(path.resolve(__dirname, '..', 'src', 'ai.js'));
const store = require(path.resolve(__dirname, '..', 'src', 'store.js'));
const { validatePlan } = require(path.resolve(__dirname, '..', 'src', 'core.js'));

async function propose(text, opts = {}) {
  const gen = await planFromText(text, opts);
  return gen;
}

function bind(phrase, plan, meta = {}) {
  const check = validatePlan(plan);
  if (!check.ok) return { ok: false, errors: check.errors };
  const out = store.bind(phrase, check.plan, meta);
  return { ok: out.ok, entry: out.entry, plan: check.plan };
}

function list() {
  return store.list();
}

function lookup(phrase) {
  return store.lookup(phrase);
}

function remove(phrase) {
  return store.remove(phrase);
}

// 带计划原文的列表：GUI 用它把"同一个计划"的多个词并成一行
function listVerbose() {
  const file = require('./config.js').FILES.plans;   // 统一走用户数据目录
  let data = {};
  try { data = JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch { data = {}; }
  return Object.values(data).map((e) => ({
    say: e.say,
      kind: e.kind || 'primary',
      aliasOf: e.aliasOf || '',
      thresholds: e.thresholds || { m1: null, m2: null },
    plan: e.plan,
    steps: e.plan && e.plan.steps ? e.plan.steps.length : 0,
    pauseMs: typeof e.pauseMs === 'number' ? e.pauseMs : 1000,
    noLead: Boolean(e.noLead),
    model: e.model,
    boundAt: e.boundAt,
  }));
}

module.exports = { propose, bind, list, listVerbose, lookup, remove, models: listModels };
