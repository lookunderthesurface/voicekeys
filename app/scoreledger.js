// 策略评分账本：用累计比例回答"我们的策略到底在变好还是变坏"。
//
// 规则（2026-11-15 用户定）：
//   · 真真（老师判真 + 我们也正确判真）→ 分子 +1，分母 +1
//   · 假真（老师判假 + 我们判真，即误触发）→ 只加分母（比例被拉低）
//   · 真假（老师判真 + 我们没判真，即漏检）→ 分子 -1（比例被拉低，扣得更狠）
//   · 假假（两边都判假）→ 不计（没有信息量，采集阶段本来也会被清洗掉）
//
// 关键点：**每条录音只结算一次**（entry.counted），所以反复跑复核不会重复加分。
// 账本持久化在 <capture>/score.json，跨会话累计。
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'score.json';

function emptyLedger() {
  return {
    numerator: 0,
    denominator: 0,
    events: { truePositive: 0, falsePositive: 0, falseNegative: 0 },
    history: [],   // 每次结算留一行，便于看趋势
    updatedAt: null,
  };
}

function load(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, FILE), 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return { ...emptyLedger(), ...data, events: { ...emptyLedger().events, ...(data.events || {}) } };
  } catch {
    return emptyLedger();
  }
}

function save(dir, ledger) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify(ledger, null, 2));
  } catch { /* ignore */ }
}

function ratio(ledger) {
  if (!ledger.denominator) return null;
  return ledger.numerator / ledger.denominator;
}

/**
 * 把一批复核结果结算进账本。只会处理还没结算过的条目。
 * @param {object} ledger
 * @param {Array} rows 复核报表的行（含 id/file、teacherWord、firedWord）
 * @param {Map<string, object>} entryById id -> 索引条目（会被打上 counted 标记）
 * @returns {{ledger:object, counted:number, delta:{tp:number,fp:number,fn:number}}}
 */
function apply(ledger, rows, entryById) {
  const next = JSON.parse(JSON.stringify(ledger));
  const delta = { tp: 0, fp: 0, fn: 0 };
  let counted = 0;

  for (const row of rows) {
    const entry = entryById.get(row.id);
    if (!entry || entry.counted) continue;

    const teacherWord = row.teacherWord || '';
    const firedWord = entry.fired ? (entry.firedWord || '') : '';

    if (teacherWord && firedWord && firedWord === teacherWord) {
      next.numerator += 1;
      next.denominator += 1;
      next.events.truePositive += 1;
      delta.tp += 1;
    } else if (!teacherWord && firedWord) {
      next.denominator += 1;
      next.events.falsePositive += 1;
      delta.fp += 1;
    } else if (teacherWord && firedWord !== teacherWord) {
      next.numerator = Math.max(0, next.numerator - 1);
      next.events.falseNegative += 1;
      delta.fn += 1;
    } else {
      // 两边都判假：不结算，但也不该反复统计——打上标记跳过
    }

    entry.counted = true;
    counted += 1;
  }

  if (counted) {
    next.updatedAt = new Date().toISOString();
    next.history.push({
      at: next.updatedAt,
      counted,
      delta,
      numerator: next.numerator,
      denominator: next.denominator,
      ratio: ratio(next),
    });
    if (next.history.length > 200) next.history = next.history.slice(-200);
  }

  return { ledger: next, counted, delta };
}

/** 给界面看的摘要 */
function summary(ledger) {
  const r = ratio(ledger);
  const last = ledger.history[ledger.history.length - 1] || null;
  return {
    numerator: ledger.numerator,
    denominator: ledger.denominator,
    ratio: r,
    percent: r == null ? null : Number((r * 100).toFixed(1)),
    events: ledger.events,
    updatedAt: ledger.updatedAt,
    lastBatch: last,
    // 趋势：最近 5 次的比值（没有就是空）
    trend: ledger.history.slice(-5).map((h) => (h.ratio == null ? null : Number((h.ratio * 100).toFixed(1)))),
  };
}

module.exports = { load, save, apply, ratio, summary, emptyLedger, FILE };
