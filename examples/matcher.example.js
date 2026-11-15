# 示例：自定义匹配算法（把它复制到「① 备份并开始编辑」生成的 user/matcher.js 里覆盖）

给用户的思路说明：
- 默认实现用的是"字符相似 + 拼音相似 + 端尾/前缀容错"，阈值在这份文件里写死
- 你可以换成任何写法：编辑距离、音节对齐、向量相似度……只要导出下面两个函数

接口约定：
- `matchAtEnd(text, words, opts)` → 返回 `{ word, score, how }` 或 `null`；`opts.threshold` 是最低分
- `bestScore(text, words)` → 返回词表里最像的那个 `{ word, score, how }`
- `match(text, words)` → 不要求句尾匹配，返回所有候选（GUI 里看得到）

下面这个例子故意写得很简单，只为演示形状：只做精确包含。
*/

function normalize(text) {
  return String(text || '').replace(/[\s，。、！？,.!?]/g, '').toLowerCase();
}

function matchAtEnd(text, words, opts = {}) {
  const t = normalize(text);
  if (!t) return null;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.7;
  let best = null;
  for (const w of words || []) {
    const wk = normalize(w.word);
    if (!wk || !t.endsWith(wk)) continue;
    const score = 1;
    if (!best || score > best.score) best = { word: w.word, score, how: 'exact' };
  }
  return best && best.score >= threshold ? best : null;
}

function bestScore(text, words) {
  const t = normalize(text);
  let best = null;
  for (const w of words || []) {
    const wk = normalize(w.word);
    if (!wk) continue;
    const score = t.includes(wk) ? 1 : 0;
    if (!best || score > best.score) best = { word: w.word, score, how: 'contains' };
  }
  return best;
}

function match(text, words) {
  const b = bestScore(text, words);
  return b && b.score > 0 ? [b] : [];
}

module.exports = { matchAtEnd, bestScore, match };
