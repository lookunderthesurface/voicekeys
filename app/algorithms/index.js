// 算法层的统一入口：所有"可以换掉的算法"都从这里取。
//
// 为什么要有这一层：
//   匹配、采样、静音门这些都是主观策略，没有唯一正确答案。把它们的实现和调用方解耦，
//   用户（或帮他们改代码的 AI）只要在 app/algorithms/user/ 放一个同接口的文件，
//   在 settings.json 里指过去就能替换，不用碰 server.js / capture.js。
//
// 契约见 app/algorithms/README.md；默认实现在同目录的 *.default.js。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const USER_DIR = path.join(require('../config.js').DIRS.algorithms, 'user');
const SETTINGS = require('../config.js').FILES.settings;

const DEFAULTS = {
  matcher: path.join(__dirname, 'matcher.default.js'),
  sampler: path.join(__dirname, 'sampler.default.js'),
  gate: path.join(__dirname, 'gate.default.js'),
};

// 每个角色必须实现的方法（缺了就当用户实现无效，回退默认）
const REQUIRED = {
  matcher: ['match', 'bestScore'],
  sampler: ['decide'],
  gate: ['pauseMs', 'ignoreNoisy'],
};

function loadUserConfig() {
  try {
    const raw = fs.readFileSync(SETTINGS, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    return (cfg && cfg.algorithms) || {};
  } catch {
    return {};
  }
}

/**
 * 从磁盘加载算法模块：读文件 + vm 编译执行。
 * 为什么不用 require：pkg / Node SEA 打包后 require 会被快照文件系统接管，
 * 读不到 exe 外面的 .js；而用户改的算法必须放在外面。fs + vm 与打包方式无关，
 * 也不需要任何编译工具链（JS 是解释执行的）。
 */
function loadModuleFromDisk(file) {
  const code = fs.readFileSync(file, 'utf8');
  const module = { exports: {} };
  const fn = vm.compileFunction(code, ['module', 'exports', 'require', '__filename', '__dirname'], { filename: file });
  fn(module, module.exports, require, file, path.dirname(file));
  return module.exports;
}

function loadRole(role, spec) {
  const fallback = loadModuleFromDisk(DEFAULTS[role]);
  if (!spec) return { impl: fallback, name: 'default' };

  const file = path.isAbsolute(spec) ? spec : path.join(USER_DIR, spec);
  try {
    if (!fs.existsSync(file)) throw new Error('文件不存在: ' + file);
    const impl = loadModuleFromDisk(file);
    const missing = REQUIRED[role].filter((m) => typeof impl[m] !== 'function');
    if (missing.length) throw new Error('缺少方法: ' + missing.join(', '));
    return { impl, name: path.basename(file) };
  } catch (e) {
    // 用户的实现有问题时不能让整个应用起不来：记下来，用默认实现继续跑
    console.warn(`[algorithms] ${role} 载入失败（${e.message}），已回退默认实现`);
    return { impl: fallback, name: 'default', error: e.message };
  }
}

const cfg = loadUserConfig();
const loaded = {};
const status = {};
for (const role of Object.keys(DEFAULTS)) {
  const r = loadRole(role, cfg[role]);
  loaded[role] = r.impl;
  status[role] = { active: r.name, error: r.error || null };
}

module.exports = {
  matcher: loaded.matcher,
  sampler: loaded.sampler,
  gate: loaded.gate,
  status,
  roles: Object.keys(DEFAULTS),
  userDir: USER_DIR,
};
