// 用户数据根目录：像正常软件一样，第一次运行就在用户目录下建好，所有可变数据都放这里
//
//   默认位置： %LOCALAPPDATA%\VoiceKeys\
//     config.json      首次运行生成的说明/默认值（给人看的）
//     settings.json    界面设置（模型来源、阈值、采集上限…）
//     plans.json       关键词 → 计划 的绑定表
//     algorithms\      用户自定义算法 + .backup\ 快照
//     capture\         校准素材（录音 + index.jsonl）
//     models\          ASR 模型（首次运行按需下载）
//     logs\            app.log / app.err
//
// 为什么放 LOCALAPPDATA：这是 Windows 上"每用户、可写、不进漫游"的规范位置，
// 卸载程序只删安装目录时用户数据还在；升级覆盖安装不会丢配置。
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const LEGACY = path.join(process.env.LOCALAPPDATA || '', 'dsh-voice');
const DEFAULT_ROOT = path.join(process.env.LOCALAPPDATA || APP_ROOT, 'VoiceKeys');

function dataRoot() {
  const explicit = process.env.VOICEKEYS_DATA || process.env.VK_DATA_DIR;
  if (explicit) return explicit;
  return DEFAULT_ROOT;
}

const ROOT = dataRoot();
const DIRS = {
  root: ROOT,
  algorithms: path.join(ROOT, 'algorithms'),
  backups: path.join(ROOT, 'algorithms', '.backup'),
  capture: path.join(ROOT, 'capture'),
  models: process.env.VOICEKEYS_MODELS || customModelsDir() || path.join(ROOT, 'models'),
  logs: path.join(ROOT, 'logs'),
};

const FILES = {
  config: path.join(ROOT, 'config.json'),
  settings: path.join(ROOT, 'settings.json'),
  plans: path.join(ROOT, 'plans.json'),
  log: path.join(ROOT, 'logs', 'app.log'),
  err: path.join(ROOT, 'logs', 'app.err'),
};

/**
 * 用户在界面里指定的模型目录（settings.json 的 modelsDir）。
 * 这里直接读文件、不 require providers：providers 反过来 require config，会形成循环依赖。
 */
function customModelsDir() {
  try {
    const f = path.join(ROOT, 'settings.json');
    if (!fs.existsSync(f)) return null;
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    return cfg && typeof cfg.modelsDir === 'string' && cfg.modelsDir ? cfg.modelsDir : null;
  } catch { return null; }
}

const CONFIG_TEMPLATE = {
  app: 'VoiceKeys',
  version: 1,
  note: '这个目录是 VoiceKeys 的用户数据目录。可改的东西都在这里；删掉本目录 = 恢复出厂设置。',
  layout: {
    'settings.json': '界面设置（模型来源、阈值、每词静音门…）',
    'plans.json': '关键词 → 动作计划（也可以让你的 agent 直接往这里写）',
    'algorithms/': '你自己改过的算法（点"备份并开始编辑"才会出现）',
    'algorithms/.backup/': '每次开始编辑前的快照',
    'capture/': '校准用的录音素材与建议',
    'models/': '语音模型（首次运行按需下载）',
    'logs/': '日志',
  },
};

/**
 * 首次运行创建目录与说明文件；如果发现旧的 dsh-voice 目录则迁移过来。
 * @returns {{root:string, created:boolean, migratedFrom:string|null}}
 */
function ensure() {
  let created = false;
  let migratedFrom = null;

  // 老目录迁移：只在新目录还不存在、老目录存在时做一次
  if (!process.env.VOICEKEYS_DATA && !process.env.VK_DATA_DIR && !fs.existsSync(ROOT) && fs.existsSync(LEGACY)) {
    try {
      fs.renameSync(LEGACY, ROOT);
      migratedFrom = LEGACY;
    } catch {
      // 跨盘或占用时退回复制
      try {
        fs.cpSync(LEGACY, ROOT, { recursive: true });
        migratedFrom = LEGACY;
      } catch { /* 放弃迁移，按全新安装处理 */ }
    }
  }

  for (const dir of Object.values(DIRS)) {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); created = true; }
  }
  if (!fs.existsSync(FILES.config)) {
    fs.writeFileSync(FILES.config, JSON.stringify(CONFIG_TEMPLATE, null, 2), 'utf8');
    created = true;
  }
  if (!fs.existsSync(FILES.plans)) {
    fs.writeFileSync(FILES.plans, '{}\n', 'utf8');
  }
  seedPlans();
  return { root: ROOT, created, migratedFrom };
}


/**
 * 首次运行时塞一份示例词表，让用户一打开就有能用的词。
 * 只在他自己还没绑过任何词的时候做（plans.json 是 {} 或不存在）。
 */
function seedPlans() {
  try {
    const raw = fs.existsSync(FILES.plans) ? fs.readFileSync(FILES.plans, 'utf8').trim() : '';
    const has = raw && raw !== '{}' && Object.keys(JSON.parse(raw)).length > 0;
    if (has) return false;
    const sample = path.join(APP_ROOT, 'examples', 'plans.example.json');
    if (!fs.existsSync(sample)) return false;
    fs.copyFileSync(sample, FILES.plans);
    return true;
  } catch { return false; }
}

module.exports = { ROOT, DIRS, FILES, ensure, seedPlans, DEFAULT_ROOT, APP_ROOT };
