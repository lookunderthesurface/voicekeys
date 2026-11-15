// 本地模型：一句中文需求 -> 一份可执行的计划 JSON。
//
// 直接把原语表塞进 system prompt（由 core.js 自动生成，不会和实现漂移），
// 要求模型只输出 {"steps":[...]}；校验失败时把错误回给它重试一次。
const http = require('node:http');
const { primitiveCatalog, validatePlan, listCustomActions } = require('./core');

// 压测结论（22 条真实需求）：2b 14/22、9b 22/22。计划是提前生成并缓存的，
// 一秒多的延迟无所谓，所以默认用 9b；要快可以 VOICEKEYS_MODEL=qwen3.5:2b。
const DEFAULT_MODEL = process.env.VOICEKEYS_MODEL || 'qwen3.5:9b';
const ENDPOINT = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

function httpJson(pathname, payload, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const url = new URL(pathname, ENDPOINT);
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ error: 'bad json from ollama' });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function systemPrompt() {
  const catalog = primitiveCatalog();
  const custom = listCustomActions().map((c) => ({ id: c.id, desc: c.desc || '(user action)', params: c.params || {} }));
  return [
    '你是语音助手的计划生成器。把用户的一句中文需求翻译成 JSON 计划。',
    '只能使用下面这张“安全原语表”里的动作，不能发明新动作，不能写代码。',
    '输出格式：{"steps":[{"op":"动作id", ...参数}]}',
    '规则：',
    '- 中文数字必须转成阿拉伯数字（四十=40，一百五=150，十五=15）。',
    '- 「调大/大声/高一点」是 audio.volume.delta 正数；「调小/小声/低一点」是负数。',
    '- 「暂停/播放视频、音乐」用 key.press + media_play_pause，不要用静音。',
    '- 需要重复时用 flow.repeat（times + body）；等待用 flow.wait（ms）。',
    '- 如果需求无法用原语表表达（打开程序、关屏幕、查天气、改系统设置），输出 {"steps":[],"reason":"…"}，不要用别的动作硬凑。',
    '- 不要输出任何解释文字，只输出 JSON。',
    '',
    '示例：',
    '用户：音量调到四十 → {"steps":[{"op":"audio.volume.set","percent":40}]}',
    '用户：声音小一点 → {"steps":[{"op":"audio.volume.delta","percent":-10}]}',
    '用户：暂停视频 → {"steps":[{"op":"key.press","key":"media_play_pause"}]}',
    '用户：静音三秒后恢复 → {"steps":[{"op":"audio.mute.toggle"},{"op":"flow.wait","ms":3000},{"op":"audio.mute.toggle"}]}',
    '用户：音量调大三次 → {"steps":[{"op":"flow.repeat","times":3,"body":[{"op":"audio.volume.delta","percent":10}]}]}',
    '',
    '安全原语表：',
    JSON.stringify(catalog, null, 0),
    custom.length ? '\n用户自定义动作（可以直接用）：\n' + JSON.stringify(custom, null, 0) : '',
  ].join('\n');
}

async function chat(model, messages) {
  const res = await httpJson('/api/chat', {
    model,
    stream: false,
    format: 'json',
    think: false,
    options: { temperature: 0, num_predict: 600 },
    messages,
  });
  if (res.error) return { error: res.error };
  const content = res.message && res.message.content;
  if (!content) return { error: 'empty response' };
  try {
    return { plan: JSON.parse(content), raw: content };
  } catch {
    return { error: 'model did not return json', raw: content };
  }
}

/** @returns {{ok:boolean, plan?:object, errors?:string[], warnings?:string[], ms:number, model:string, attempts:number}} */
async function planFromText(text, { model = DEFAULT_MODEL } = {}) {
  const t0 = Date.now();
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: text },
  ];

  let attempt = 0;
  let lastErr = null;
  while (attempt < 2) {
    attempt += 1;
    const out = await chat(model, messages);
    if (out.error) { lastErr = out.error; continue; }
    const check = validatePlan(out.plan);
    if (check.ok) {
      return { ok: true, plan: check.plan, warnings: check.warnings, ms: Date.now() - t0, model, attempts: attempt };
    }
    lastErr = check.errors.join('; ');
    // 把错误回给模型，让它改
    messages.push({ role: 'assistant', content: out.raw || JSON.stringify(out.plan) });
    messages.push({ role: 'user', content: `刚才的计划不合法：${lastErr}。请只修改并重新输出 JSON。` });
  }
  return { ok: false, errors: [lastErr || 'unknown'], ms: Date.now() - t0, model, attempts: attempt };
}

async function listModels() {
  return new Promise((resolve) => {
    const url = new URL('/api/tags', ENDPOINT);
    http.get({ host: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve((JSON.parse(data).models || []).map((m) => ({ name: m.name, sizeGB: Math.round((m.size / 1e9) * 10) / 10 })));
        } catch {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

module.exports = { planFromText, listModels, DEFAULT_MODEL, systemPrompt };
