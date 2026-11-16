// 默认匹配算法：整句相似度（字符 + 拼音），带长度护栏。
// 想换成别的思路（例如编辑距离、向量相似度、规则表），照这个接口写一个新文件即可。
const core = require('../matcher.js');

// 契约（必须实现）：
//   match(text, words, opts) -> {word, planKey, score, how} | {ambiguous:[...]} | null
//   bestScore(text, words)   -> {word, planKey, score, how} | null   （不看阈值）
// words: [{word, planKey}]
module.exports = {
  name: 'default-fuzzy',
  match: core.matchOne,
  matchAtEnd: core.matchAtEnd,   // 只认"整句话以它结尾"的词（挡掉一句话里的半句）
  findWord: core.findWord,       // 在整句里滑窗找关键词（给 M2 的整句转写用）
  scoreAll: core.scoreAll,       // 对所有词打分并排序（判断"有没有第二名的干扰"）
  bestScore: core.bestScore,
  // 以下不是契约要求，但别的算法可能复用
  scoreAgainst: core.scoreAgainst,
  normalize: core.normalize,
  toPinyin: core.toPinyin,
  editDistance: core.editDistance,
  similarity: core.similarity,
};
