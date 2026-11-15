// 读 JSON 的统一入口：去掉 UTF-8 BOM。
// 为什么需要：Windows 上用记事本 / PowerShell 5.1 的 Set-Content 写出来的 JSON 带 BOM，
// JSON.parse 会直接抛错，调用方一旦 catch 掉就变成“配置被静默忽略”——踩过一次。
const fs = require('node:fs');

function stripBom(text) {
  if (typeof text !== 'string') return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return fallback;
  }
}

module.exports = { readJson, stripBom };
