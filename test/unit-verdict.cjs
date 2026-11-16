// 单元验证新的裁决逻辑（用真实的相似度，不启动模型）
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { Pipeline } = require(path.join(ROOT, 'app', 'pipeline', 'index.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;

const words = ['我说完了', '听我说', '播放视频', '暂停视频', '静音'];
const mk = (m2text) => {
  const pipeline = new Pipeline({
    m1: matcher,
    words: () => words.map((w) => ({ word: w, planKey: w })),
    m2: { confirm: async () => ({ text: m2text, ms: 40 }) },
    audio: () => new Float32Array(16000 * 2.5),
  });
  return pipeline;
};

const cases = [
  { name: 'M2 认同候选词', cand: '我说完了', m1: 0.25, m2text: '我说完了' },
  { name: 'M2 听成近音词（候选=听我说）', cand: '听我说', m1: 0.85, m2text: '我说完了' },
  { name: 'M2 听成近音词但 M1 不自信', cand: '听我说', m1: 0.40, m2text: '我说完了' },
  { name: 'M2 听到无关内容', cand: '静音', m1: 0.50, m2text: '今天天气不错' },
  { name: 'M2 听到别的词（不相关）', cand: '静音', m1: 0.50, m2text: '播放视频' },
];

(async () => {
  for (const c of cases) {
    const pipeline = mk(c.m2text);
    const handle = { audio: new Float32Array(30000), promise: Promise.resolve({ text: c.m2text, ms: 40 }) };
    const verdict = await pipeline.finish(
      { word: c.cand, score: c.m1, how: 'pinyin' },
      handle,
      { threshold: 0.7, isHandy: false },
    );
    console.log('  ' + c.name);
    console.log('    候选「' + c.cand + '」 M1=' + c.m1 + '  M2 转录「' + c.m2text + '」');
    console.log('    → ' + verdict.action + ' ' + (verdict.word || '') + '  [' + verdict.rule + ']  ' + (verdict.m2 && verdict.m2.note ? verdict.m2.note : ''));
  }
})();
