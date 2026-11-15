// 数据集清洗：复核之后，把"双方都不认为是命令"的录音删掉。
//
// 规则（2026-11-15 用户定）：只保留"至少一方判为真"的样本——
//   · 我们（14M）触发了
//   · 或老师（Qwen3-ASR 0.6B）认为这是某个词
//   · 或两者都认为
// 两边都是"假"的样本对改进触发没有任何信息量（我们没触发、老师也觉得不是命令），
// 只会占容量，直接删除。
//
// 例外：keepNegatives（默认 0）可以保留少量纯负样本作为回归对照，
// 因为将来如果误触发率上升，需要负样本才能测出来。
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object} opts
 * @param {string} opts.dir 采集目录
 * @param {Array} opts.entries 索引条目
 * @param {object} opts.report 复核报表（含 rows，每行有 teacherWord / fired）
 * @param {number} [opts.keepNegatives=0] 保留几条纯负样本
 * @returns {{removed:number, kept:number, keptNegatives:number, remaining:number}}
 */
function curate({ dir, entries, report, keepNegatives = 0 }) {
  const rows = (report && report.rows) || [];
  const byFile = new Map(rows.map((r) => [r.file, r]));

  const negatives = [];
  const keep = [];
  for (const e of entries) {
    const row = byFile.get(e.file) || {};
    const teacherSaysCommand = Boolean(row.teacherWord);
    const weSaidCommand = Boolean(e.fired);
    if (teacherSaysCommand || weSaidCommand) keep.push(e);
    else negatives.push(e);
  }

  // 纯负样本按时间保留最后 N 条（最新的更有代表性）
  // 注意：不能用 slice(-0)——-0 === 0，会返回整个数组，导致"保留 0 条"变成"全留"
  const keepN = Math.max(0, Number(keepNegatives) || 0);
  const keptNeg = keepN > 0 ? negatives.slice(-keepN) : [];
  const removedEntries = negatives.filter((e) => !keptNeg.includes(e));
  const finalEntries = keep.concat(keptNeg).sort((a, b) => a.id.localeCompare(b.id));

  // 删文件
  let removed = 0;
  for (const e of removedEntries) {
    try { fs.unlinkSync(path.join(dir, e.file)); removed += 1; } catch { /* 文件可能已不在 */ }
  }

  // 重写索引（保留原 id，避免 id 重新编号造成混乱）
  try {
    fs.writeFileSync(path.join(dir, 'index.jsonl'), finalEntries.map((e) => JSON.stringify(e)).join('\n') + (finalEntries.length ? '\n' : ''));
  } catch { /* ignore */ }

  return {
    removed,
    removedEntries: removedEntries.length,
    kept: keep.length,
    keptNegatives: keptNeg.length,
    remaining: finalEntries.length,
  };
}

module.exports = { curate };
