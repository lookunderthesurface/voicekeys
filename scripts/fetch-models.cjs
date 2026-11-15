// 首次运行：下载语音模型（模型不进 git，也不该打进安装包）
//
// 用法：node scripts/fetch-models.cjs
//   · 默认下到 <用户数据目录>/models/asr/
//   · 已经存在的跳过
//   · 只下 M1（流式，24MB）与 M2（非流式，80MB）；老师模型 811MB 只在用校准时才需要
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../app/config.js');

const MODELS = [
  {
    name: 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2',
    why: 'M1 流式识别（边听边出字）',
    must: 'encoder-epoch-99-avg-1.int8.onnx',
  },
  {
    name: 'sherpa-onnx-paraformer-zh-small-2024-03-09',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2',
    why: 'M2 确认模型（重听一遍这句话）',
    must: 'model.int8.onnx',
  },
];

function has(dir, must) {
  return fs.existsSync(path.join(dir, must));
}

function download(url, dest) {
  // 用 curl.exe：Windows 10+ 自带，支持断点与重定向，比手写 https 简单
  execFileSync('curl.exe', ['-L', '--retry', '3', '--fail', '-o', dest, url], { stdio: 'inherit' });
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar.exe', ['-xjf', archive, '-C', dest], { stdio: 'inherit' });
}

async function main() {
  const root = path.join(config.DIRS.models, 'asr');
  fs.mkdirSync(root, { recursive: true });
  console.log('  模型目录: ' + root);

  let downloaded = 0;
  for (const m of MODELS) {
    const dir = path.join(root, m.name);
    if (has(dir, m.must)) {
      console.log('  ✔ 已有: ' + m.name);
      continue;
    }
    console.log('  ↓ ' + m.why + '：' + m.name);
    const archive = path.join(root, m.name + '.tar.bz2');
    download(m.url, archive);
    console.log('  ⇩ 解压…');
    extract(archive, root);
    try { fs.unlinkSync(archive); } catch { /* ignore */ }
    if (!has(dir, m.must)) {
      console.error('  ✘ 解压后仍找不到 ' + m.must + '，请检查压缩包结构');
      process.exit(1);
    }
    downloaded += 1;
  }

  console.log('');
  console.log(downloaded ? '  ✔ 完成：新下载 ' + downloaded + ' 个模型' : '  ✔ 全部就绪');
  console.log('  启动：node app/server.js   然后浏览 http://127.0.0.1:19600/');
}

main();
