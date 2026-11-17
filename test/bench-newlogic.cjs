// 用"新逻辑"回放真实素材，算召回/误触：
//   新逻辑 = M1 连续两帧同一结论（none / confident / possible）才进门 → 600ms 静音门 → 
//             confident 直接执行；possible 用 M2（最后 4 秒）裁决
// 对照：旧逻辑 = 一帧就判断（同样门 + M2 2.5 秒窗口）
// 答案：1.7B 老师（VK_TEACHER_MODEL 指向 1.7B）
// 用法：node test/bench-newlogic.cjs [素材目录]
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const paths = require(path.join(ROOT, 'app', 'paths.js'));
const config = require(path.join(ROOT, 'app', 'config.js'));
const planner = require(path.join(ROOT, 'app', 'planner.js'));
const matcher = require(path.join(ROOT, 'app', 'algorithms', 'index.js')).matcher;
const policy = require(path.join(ROOT, 'app', 'pipeline', 'policy.js'));
const teacher = require(path.join(ROOT, 'app', 'teacher.js'));
const { readWav } = require(path.join(paths.pluginRoot(), 'runtime', 'listener', 'audio.cjs'));
const sherpa = require(path.join(paths.packageDir('sherpa-onnx-node') || '', 'node_modules', 'sherpa-onnx-node'));

const ASR = path.join(config.DIRS.models, 'asr');
const M1_DIR = path.join(ASR, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
const M2_DIR = path.join(ASR, 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const SR = 16000;
const FRAME = 1600;
const PAUSE_MS = 600;
const RING_MS = 6000;
const M2_WIN_MS = 4000;
const LEAD_MS = 2000;        // 素材前面补 2 秒静音，模拟环形缓冲里已有音频
const cap = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'VoiceKeys', 'capture');

const verbose = planner.listVerbose();
const words = verbose.map((p) => ({ word: p.say, planKey: p.say }));
const planOf = new Map(verbose.map((p) => [p.say, JSON.stringify((p.plan && p.plan.steps) || [])]));
const samePlan = (a, b) => a && b && planOf.get(a) === planOf.get(b);

const m1 = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: SR, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(M1_DIR, 'encoder-epoch-99-avg-1.int8.onnx'),
      decoder: path.join(M1_DIR, 'decoder-epoch-99-avg-1.int8.onnx'),
      joiner: path.join(M1_DIR, 'joiner-epoch-99-avg-1.int8.onnx'),
    },
    tokens: path.join(M1_DIR, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0,
  },
  decodingMethod: 'greedy_search',
});
const m2 = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: SR, featureDim: 80 },
  modelConfig: {
    paraformer: { model: path.join(M2_DIR, 'model.int8.onnx') },
    tokens: path.join(M2_DIR, 'tokens.txt'), numThreads: 8, provider: 'cpu', debug: 0,
  },
});
function m2Text(pcm) {
  const st = m2.createStream();
  st.acceptWaveform({ sampleRate: SR, samples: pcm });
  m2.decode(st);
  return (m2.getResult(st).text || '').trim();
}
function propose(text) {
  if (!text) return null;
  const endMatch = matcher.matchAtEnd(text, words, { threshold: 0.7 });
  if (endMatch && !endMatch.ambiguous && endMatch.score >= 0.7) return { word: endMatch.word, score: endMatch.score, how: endMatch.how, margin: null };
  const best = matcher.bestScore(text, words);
  if (!best || best.score < policy.DEFAULT_POLICY.candidateFloor) return null;
  const all = matcher.scoreAll(text, words);
  const second = all[1] ? all[1].score : 0;
  return { word: best.word, score: best.score, how: best.how || 'loose', margin: Math.max(0, (best.score || 0) - second) };
}
function judge(cand, m2txt) {
  return policy.verdictFromScores({
    candidate: cand.word, m1Score: Number(cand.score) || 0, m1How: cand.how,
    scored: matcher.scoreAll(m2txt, words), thresholdOf: () => Number(process.env.VK_M2_TH || 0.7),
  });
}

/** 回放一条素材；twoFrame=true 走新逻辑 */
function runNeo(base, twoFrame) {
  const buf = new Float32Array(base.length + Math.round((LEAD_MS / 1000) * SR));
  buf.set(base, Math.round((LEAD_MS / 1000) * SR));
  const st = m1.createStream();
  let history = [];
  let pending = null;   // { cand, at, kind, m2 }
  const firstCandidateAt = {};
  for (let i = 0; i + FRAME <= buf.length; i += FRAME) {
    st.acceptWaveform({ sampleRate: SR, samples: buf.subarray(i, i + FRAME) });
    while (m1.isReady(st)) m1.decode(st);
    const text = (m1.getResult(st).text || '').trim();
    const cand = propose(text);
    const kind = !cand ? 'none' : policy.shouldFastPath({ score: cand.score, margin: cand.margin, isHandy: false }) ? 'confident' : 'possible';

    if (!pending) {
      if (!twoFrame) {
        if (cand) {
          const m2txt = kind === 'possible'
            ? m2Text(buf.subarray(Math.max(0, i - Math.round((M2_WIN_MS / 1000) * SR)), i))
            : '';
          pending = { cand, at: i, kind, m2: m2txt };
        }
      } else {
        history.push(kind + '|' + (cand ? cand.word : ''));
        if (history.length > 2) history.shift();
        const stable = history.length === 2 && history[0] === history[1];
        if (stable && cand) {
          const m2txt = kind === 'possible'
            ? m2Text(buf.subarray(Math.max(0, i - Math.round((M2_WIN_MS / 1000) * SR)), i))
            : '';
          pending = { cand, at: i, kind, m2: m2txt };
        }
      }
    }
    if (pending && ((i - pending.at) / SR) * 1000 >= PAUSE_MS) {
      let acted = null;
      let rule = '';
      if (pending.kind === 'confident') { acted = pending.cand.word; rule = 'fast-path'; }
      else {
        const v = judge(pending.cand, pending.m2 || '');
        rule = v.rule;
        acted = (v.action === 'fire' || v.action === 'swap') ? v.word : null;
      }
      return { fired: true, acted, rule, cand: pending.cand.word, candScore: pending.cand.score, candHow: pending.cand.how, m2: pending.m2 || '', waitMs: (pending.at / SR) * 1000 };
    }
    if (m1.isEndpoint(st)) m1.reset(st);
  }
  return { fired: false, acted: null, rule: 'gate-never' };
}

(async () => {
  const files = fs.readdirSync(cap).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  console.log('  素材: ' + cap);
  console.log('  条数: ' + files.length + '（全部是"触发过"才录下的）');
  console.log('  老师转写中…');
  const t = await teacher.transcribeMany(files.map((f) => path.join(cap, f)));
  if (!t.ok) { console.log('  ✘ 老师失败: ' + t.error); return; }

  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '');
  const rows = [];
  for (const f of files) {
    const teacherText = t.results[f] || '';
    // 老师说出的关键词（可能多个）
    const expected = words.filter((w) => {
      const s = matcher.scoreAll(teacherText, [{ word: w.word }])[0];
      return norm(teacherText).includes(norm(w.word)) || (s && s.score >= 0.7);
    }).map((w) => w.word);
    const wav = readWav(path.join(cap, f));
    const base = wav.samples || wav;
    const neu = runNeo(base, true);
    const old = runNeo(base, false);
    rows.push({ f, teacherText, expected, neu, old });
  }

  const okOf = (r, act) => act && r.expected.some((e) => act === e || samePlan(act, e));
  const sum = (key) => {
    let correct = 0, wrong = 0, miss = 0, falseFire = 0;
    for (const r of rows) {
      const res = r[key];
      const act = res.acted;
      if (r.expected.length) {
        if (!act) miss += 1;
        else if (okOf(r, act)) correct += 1;
        else wrong += 1;
      } else if (act) falseFire += 1;
    }
    return { correct, wrong, miss, falseFire, total: rows.length };
  };
  const sn = sum('neu');
  const so = sum('old');

  console.log('');
  console.log('  === 汇总（分母 = 全部 ' + rows.length + ' 条素材） ===');
  console.log('  新逻辑（连续两帧）: 正确 ' + sn.correct + '  错词 ' + sn.wrong + '  漏响 ' + sn.miss + '  无词却执行 ' + sn.falseFire);
  console.log('  旧逻辑（一帧）    : 正确 ' + so.correct + '  错词 ' + so.wrong + '  漏响 ' + so.miss + '  无词却执行 ' + so.falseFire);
  console.log('');
  console.log('  === 逐条 ===');
  for (const r of rows) {
    console.log('  ' + r.f + ' 老师「' + r.teacherText + '」');
    console.log('     旧: ' + (r.old.acted ? '执行「' + r.old.acted + '」[' + r.old.rule + ']' : '未执行[' + r.old.rule + ']')
      + '   新: ' + (r.neu.acted ? '执行「' + r.neu.acted + '」[' + r.neu.rule + ']' : '未执行[' + r.neu.rule + ']'));
  }
})();
