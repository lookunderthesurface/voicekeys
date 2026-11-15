// 计划生成的多后端支持：手写 / Ollama（本地，可自动拉起）/ OpenAI 兼容 API / DeepSeek。
//
// 为什么要拆出来：之前 ai.js 写死了 Ollama:11434 + qwen3.5:9b，
// 用户需要能选"用哪个模型来生成计划"，并且能填自己的 key 和地址。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ai = require(path.resolve(__dirname, '..', 'src', 'ai.js'));

// 设置也放用户目录（见 app/config.js）：升级覆盖安装不会丢配置
const SETTINGS_FILE = require('./config.js').FILES.settings;

const PRESETS = [
  { id: 'manual', label: '手写（自己粘贴计划 JSON）', needsKey: false, needsUrl: false },
  { id: 'ollama', label: '本地 Ollama', needsKey: false, needsUrl: true, defaultUrl: 'http://127.0.0.1:11434' },
  { id: 'openai', label: 'OpenAI 兼容 API（自填地址与 key）', needsKey: true, needsUrl: true, defaultUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek 官方 API', needsKey: true, needsUrl: false, defaultUrl: 'https://api.deepseek.com/v1' },
];

function defaults() {
  return {
    matchThreshold: 0.70,
    captureMax: 500,          // 采集上限（GUI 可改）
    captureAutoClean: true,
    // 校准是实验功能：默认关闭（算法还在变，误用会改坏词表）
    calibratorEnabled: false,   // 存满时自动删除废数据（GUI 可改）
    provider: 'ollama',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen3.5:9b',
    openaiUrl: 'https://api.openai.com/v1',
    openaiKey: '',
    openaiModel: 'gpt-4o-mini',
    deepseekUrl: 'https://api.deepseek.com/v1',
    deepseekKey: '',
    deepseekModel: 'deepseek-chat',
  };
}

function load() {
  try {
    return { ...defaults(), ...(require(path.resolve(__dirname, '..', 'src', 'util.js')).readJson(SETTINGS_FILE, {}) || {}) };
  } catch {
    return defaults();
  }
}

function save(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** 给界面看的版本：key 打码 */
function publicView() {
  const s = load();
  const mask = (k) => (k ? k.slice(0, 4) + '****' + k.slice(-2) : '');
  return {
    ...s,
    openaiKey: mask(s.openaiKey),
    deepseekKey: mask(s.deepseekKey),
    hasOpenaiKey: Boolean(s.openaiKey),
    hasDeepseekKey: Boolean(s.deepseekKey),
    presets: PRESETS,
  };
}

// ---------------------------------------------------------------- HTTP 调用
function requestJson(urlStr, payload, headers = {}, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { resolve({ error: '地址不合法: ' + urlStr }); return; }
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname.replace(/\/$/, '') + (u.search || ''),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ error: `HTTP ${res.statusCode}: ${d.slice(0, 200)}` }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时' }); });
    req.write(body);
    req.end();
  });
}

function requestGet(urlStr, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { resolve({ error: 'bad url' }); return; }
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''), method: 'GET', timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d.slice(0, 120) }); } });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

// ---------------------------------------------------------------- Ollama
async function ollamaStatus() {
  const s = load();
  const r = await requestGet(s.ollamaUrl.replace(/\/$/, '') + '/api/tags');
  if (r.error) return { running: false, error: r.error, models: [] };
  return { running: true, models: (r.models || []).map((m) => m.name) };
}

/** 没在跑就尝试拉起（detached，不占窗口） */
async function ollamaStart() {
  const st = await ollamaStatus();
  if (st.running) return { started: false, already: true, models: st.models };
  try {
    spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    return { started: false, error: '拉起失败: ' + e.message };
  }
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await ollamaStatus();
    if (now.running) return { started: true, models: now.models };
  }
  return { started: false, error: '等了 10 秒还没起来' };
}

// ---------------------------------------------------------------- 生成计划
/**
 * @param {string} text 一句中文
 * @returns {Promise<{ok:boolean, plan?:object, errors?:string[], ms:number, provider:string, model:string}>}
 */
async function generatePlan(text) {
  const s = load();
  const t0 = Date.now();

  if (s.provider === 'manual') {
    return { ok: false, errors: ['当前是手写模式，请直接粘贴计划 JSON'], ms: 0, provider: 'manual', model: '' };
  }

  if (s.provider === 'ollama') {
    const st = await ollamaStatus();
    if (!st.running) {
      const up = await ollamaStart();
      if (!up.started && !up.already) {
        return { ok: false, errors: ['Ollama 没在运行，自动拉起也失败：' + (up.error || '')], ms: Date.now() - t0, provider: 'ollama', model: s.ollamaModel };
      }
    }
    const r = await ai.planFromText(text, { model: s.ollamaModel });
    return { ...r, provider: 'ollama', model: s.ollamaModel };
  }

  // OpenAI 兼容 / DeepSeek：同一个 chat/completions 协议
  const isDeepSeek = s.provider === 'deepseek';
  const baseUrl = (isDeepSeek ? s.deepseekUrl : s.openaiUrl).replace(/\/$/, '');
  const key = isDeepSeek ? s.deepseekKey : s.openaiKey;
  const model = isDeepSeek ? s.deepseekModel : s.openaiModel;
  if (!key) return { ok: false, errors: ['还没填 API key'], ms: 0, provider: s.provider, model };

  const messages = [
    { role: 'system', content: ai.systemPrompt() },
    { role: 'user', content: text },
  ];
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await requestJson(baseUrl + '/chat/completions', {
      model,
      temperature: 0,
      max_tokens: 600,
      messages,
      response_format: { type: 'json_object' },
    }, { authorization: `Bearer ${key}` });

    if (res.error) { lastErr = String(res.error); continue; }
    const content = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    if (!content) { lastErr = '返回内容为空'; continue; }
    let plan;
    try { plan = JSON.parse(content); } catch { lastErr = '模型没有返回 JSON'; continue; }

    const check = require(path.resolve(__dirname, '..', 'src', 'core.js')).validatePlan(plan);
    if (check.ok) {
      return { ok: true, plan: check.plan, warnings: check.warnings, ms: Date.now() - t0, provider: s.provider, model, attempts: attempt };
    }
    lastErr = check.errors.join('; ');
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: `刚才的计划不合法：${lastErr}。请只修改并重新输出 JSON。` });
  }
  return { ok: false, errors: [lastErr || 'unknown'], ms: Date.now() - t0, provider: s.provider, model };
}

module.exports = { generatePlan, load, save, publicView, ollamaStatus, ollamaStart, PRESETS, SETTINGS_FILE };
