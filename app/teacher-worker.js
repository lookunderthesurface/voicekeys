// 老师模型的工作进程：加载一次 Qwen3-ASR-0.6B，把给它的文件全转写完就退出。
//
// 为什么要独立进程：
//   · 这个模型是 811MB 的 GGUF，加载进主进程会一起承担 OOM / 崩溃风险
//   · 跑完退出 = 模型自然卸载，不常驻
//
// 协议（stdin 传任务、stdout 回进度）：
//   输入（一行 JSON）：{"files":["a.wav","b.wav"]}
//   输出：{"type":"ready","loadMs":1234}
//         {"type":"progress","done":1,"total":35,"file":"a.wav","text":"..."}
//         {"type":"done","ms":10000,"results":{"a.wav":"..."}}
//         {"type":"error","message":"..."}
const path = require('node:path');
const fs = require('node:fs');

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function findModel() {
  const cands = [
    process.env.VK_TEACHER_MODEL,
    path.join(process.env.USERPROFILE || '', '.cache', 'huggingface', 'hub',
      'models--handy-computer--Qwen3-ASR-0.6B-gguf', 'snapshots',
      'e4e16599b900eb0cb36e524514756bb92eb092b7', 'Qwen3-ASR-0.6B-Q8_0.gguf'),
  ].filter(Boolean);
  for (const p of cands) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 100 * 1024 * 1024) return p; } catch { /* ignore */ }
  }
  const hub = path.join(process.env.USERPROFILE || '', '.cache', 'huggingface', 'hub');
  try {
    for (const d of fs.readdirSync(hub)) {
      if (!d.includes('Qwen3-ASR')) continue;
      const snaps = path.join(hub, d, 'snapshots');
      for (const s of fs.readdirSync(snaps)) {
        for (const f of fs.readdirSync(path.join(snaps, s))) {
          if (f.endsWith('.gguf')) return path.join(snaps, s, f);
        }
      }
    }
  } catch { /* ignore */ }
  return '';
}

function loadSdk() {
  for (const t of [path.resolve(__dirname, '..', 'node_modules', 'transcribe-cpp'), 'transcribe-cpp']) {
    try { return require(t); } catch { /* next */ }
  }
  return null;
}

(async () => {
  const modelPath = findModel();
  if (!modelPath) { emit({ type: 'error', message: '找不到老师模型（Qwen3-ASR-0.6B GGUF）' }); process.exit(1); }
  const sdk = loadSdk();
  if (!sdk) { emit({ type: 'error', message: '没装 transcribe-cpp' }); process.exit(1); }

  const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(__dirname, '..', '..', 'voice-plugin');
  const { readWav } = require(path.join(PLUGIN, 'runtime', 'listener', 'audio.cjs'));

  // 任务从文件读（不用 stdin：readline 与 transcribe-cpp 的 FFI 线程一起用会让模型加载卡死）
  const jobFile = process.argv[2];
  let job = { files: [] };
  try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { emit({ type: 'error', message: '任务文件读不了: ' + jobFile }); process.exit(1); }
  {
    const files = Array.isArray(job.files) ? job.files : [];

    let model;
    const t0 = Date.now();
    try {
      model = await sdk.TranscribeModel.load(modelPath);
    } catch (e) {
      emit({ type: 'error', message: '模型加载失败: ' + String(e && e.message).split('\n')[0] });
      process.exit(1);
    }
    emit({ type: 'ready', loadMs: Date.now() - t0, modelPath });

    const results = {};
    const t1 = Date.now();
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const name = path.basename(f);
      let text = '';
      try {
        const pcm = readWav(f);
        const r = await model.transcribe(pcm, {});
        text = String((r && r.text) || '').trim();
      } catch { /* 单段失败不影响整体 */ }
      results[name] = text;
      emit({ type: 'progress', done: i + 1, total: files.length, file: name, text });
    }
    emit({ type: 'done', ms: Date.now() - t1, total: files.length, results });
    try { model.dispose(); } catch { /* ignore */ }
    process.exit(0);
  }
})();
