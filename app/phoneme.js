// 声韵母级相似度：DS-KWS 第二段的"免训练版"
//
// 字符层面「暂/淡」完全不同（0 分），但声韵母层面 z/an vs d/an 只差一个声母。
// 这正是"听错一个字"和"听成另一个词"的分界。
const { pinyin } = require('./paths.js').requirePackage('pinyin-pro');

const GAP = -0.35;

/** 把中文文本拆成 [声母, 韵母] 序列 */
function phonemes(text) {
  const s = String(text || '').replace(/[\s，。、！？,.!?]/g, '');
  if (!s) return [];
  const initials = pinyin(s, { toneType: 'none', type: 'array', pattern: 'initial' });
  const finals = pinyin(s, { toneType: 'none', type: 'array', pattern: 'final' });
  const n = Math.max(initials.length, finals.length);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push([initials[i] || '', finals[i] || '']);
  return out;
}

/** 两个音节的相似度：0 / 0.5 / 0.5 / 1 */
function syllableSim(a, b) {
  const sameI = a[0] === b[0];
  const sameF = a[1] === b[1];
  if (sameI && sameF) return 1;
  return (sameI ? 0.5 : 0) + (sameF ? 0.5 : 0);
}

/**
 * 声韵母序列对齐，返回 0~1。
 * 用"相似度最大化"的对齐（不是概率 DP），最后按较长的序列归一化，
 * 这样"同一个字不同声母"能拿到 0.5 的分，而不是直接归零。
 */
function phonemeSimilarity(a, b) {
  const A = phonemes(a);
  const B = phonemes(b);
  if (!A.length || !B.length) return 0;

  const rows = A.length + 1;
  const cols = B.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 1; i < rows; i += 1) dp[i][0] = dp[i - 1][0] + GAP;
  for (let j = 1; j < cols; j += 1) dp[0][j] = dp[0][j - 1] + GAP;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const sim = syllableSim(A[i - 1], B[j - 1]);
      dp[i][j] = Math.max(
        dp[i - 1][j - 1] + sim,
        dp[i - 1][j] + GAP,
        dp[i][j - 1] + GAP,
      );
    }
  }

  const score = dp[rows - 1][cols - 1] / Math.max(A.length, B.length);
  return Math.max(0, Math.min(1, score));
}

module.exports = { phonemes, syllableSim, phonemeSimilarity };
