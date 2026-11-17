// VoiceKeys 图标生成器 v36：位置不变（左人 → 中声波 → 右电脑），六种差异很大的艺术风格
// 灵感：2026 图标趋势里的 Liquid Glass（分层玻璃/高光/半透明）、Claymorphism（黏土 3D）、
// 蓝图线稿、16-bit 像素、贴纸、霓虹灯管。
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out');
const S = 512;
const R = 118;

// ---- 固定布局（所有风格共用）----
const HEAD = { cx: 150, cy: 168, r: 104 };
const MON = { x: 336, y: 120, w: 176, h: 168 };
const WAVE = { cx: 150, cy: 168 };

const head = () => `M ${HEAD.cx - HEAD.r} ${HEAD.cy} A ${HEAD.r} ${HEAD.r} 0 1 1 ${HEAD.cx + HEAD.r} ${HEAD.cy} A ${HEAD.r} ${HEAD.r} 0 1 1 ${HEAD.cx - HEAD.r} ${HEAD.cy}`;
const bust = () => `M -40 ${S + 40} V 400 C -40 300 60 268 ${HEAD.cx} 268 C ${HEAD.cx + 110} 268 210 300 210 400 V ${S + 40}`;
const waveArcs = (width = 24, radii = [128, 158, 188]) => radii.map((r) => {
  const a = (-34 * Math.PI) / 180;
  const b = (34 * Math.PI) / 180;
  const x1 = WAVE.cx + r * Math.cos(a);
  const y1 = WAVE.cy + r * Math.sin(a);
  const x2 = WAVE.cx + r * Math.cos(b);
  const y2 = WAVE.cy + r * Math.sin(b);
  return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke-width="${width}"/>`;
}).join('');
const monitor = (width = 24) => `<rect x="${MON.x}" y="${MON.y}" width="${MON.w}" height="${MON.h}" rx="18" stroke-width="${width}"/>
  <path d="M ${MON.x + MON.w / 2} ${MON.y + MON.h + 6} V ${MON.y + MON.h + 34}" stroke-width="${width}"/>
  <path d="M ${MON.x - 22} ${MON.y + MON.h + 34} H ${MON.x + MON.w + 38}" stroke-width="${width}"/>`;

function wrap(bg, defs, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <clipPath id="clip"><rect width="${S}" height="${S}" rx="${R}"/></clipPath>
    ${defs}
  </defs>
  <g clip-path="url(#clip)">
    ${bg}
    ${inner}
  </g>
</svg>
`;
}

const VARIANTS = {};

// ---------- 1. Liquid Glass ----------
VARIANTS.glass = (() => {
  const defs = `
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101a3a"/><stop offset="1" stop-color="#241a4d"/></linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0f2fe"/><stop offset=".5" stop-color="#c7d2fe"/><stop offset="1" stop-color="#f0abfc"/></linearGradient>
    <linearGradient id="glassPanel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".22"/><stop offset="1" stop-color="#ffffff" stop-opacity=".06"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="10"/></filter>
    <radialGradient id="lampA" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#38bdf8" stop-opacity=".55"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient>
    <radialGradient id="lampB" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#f472b6" stop-opacity=".5"/><stop offset="1" stop-color="#f472b6" stop-opacity="0"/></radialGradient>`;
  const bg = `<rect width="${S}" height="${S}" fill="url(#bg)"/>
    <ellipse cx="120" cy="120" rx="220" ry="200" fill="url(#lampA)"/>
    <ellipse cx="420" cy="400" rx="220" ry="200" fill="url(#lampB)"/>
    <rect x="26" y="26" width="${S - 52}" height="${S - 52}" rx="96" fill="url(#glassPanel)" stroke="#ffffff" stroke-opacity=".28" stroke-width="3"/>`;
  const inner = `
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="#ffffff" stroke-opacity=".22" stroke-width="40"><path d="${bust()}"/></g>
      <g stroke="url(#ink)" stroke-width="26"><path d="${head()}"/><path d="${bust()}"/>${waveArcs(26)}${monitor(26)}</g>
      <g stroke="#ffffff" stroke-opacity=".55" stroke-width="8" transform="translate(-6 -6)"><path d="${head()}"/></g>
    </g>`;
  return { title: '1. Liquid Glass', desc: '半透明玻璃面板 + 分层高光，符号像刻在玻璃里（2026 iOS 方向）。', bg, defs, inner };
})();

// ---------- 2. Clay 黏土 ----------
VARIANTS.clay = (() => {
  const defs = `
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#4c1d95"/></linearGradient>
    <linearGradient id="clay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe0c2"/><stop offset="1" stop-color="#ffb38a"/></linearGradient>
    <filter id="clayShadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#2a1458" flood-opacity=".55"/>
    </filter>`;
  const bg = `<rect width="${S}" height="${S}" fill="url(#bg)"/>`;
  const inner = `
    <g filter="url(#clayShadow)">
      <circle cx="${HEAD.cx}" cy="${HEAD.cy}" r="${HEAD.r}" fill="url(#clay)"/>
      <path d="M -20 ${S + 40} V 420 C -20 330 60 300 ${HEAD.cx} 300 C ${HEAD.cx + 90} 300 180 330 180 420 V ${S + 40} Z" fill="url(#clay)"/>
      <g fill="none" stroke="url(#clay)" stroke-linecap="round">${waveArcs(34)}</g>
      <rect x="${MON.x}" y="${MON.y}" width="${MON.w}" height="${MON.h}" rx="26" fill="url(#clay)"/>
      <rect x="${MON.x + 16}" y="${MON.y + 16}" width="${MON.w - 32}" height="${MON.h - 32}" rx="16" fill="#4c1d95" opacity=".35"/>
      <rect x="${MON.x - 16}" y="${MON.y + MON.h + 8}" width="${MON.w + 32}" height="22" rx="11" fill="url(#clay)"/>
    </g>
    <g fill="#ffffff" opacity=".45">
      <ellipse cx="${HEAD.cx - 34}" cy="${HEAD.cy - 44}" rx="26" ry="18" transform="rotate(-24 ${HEAD.cx - 34} ${HEAD.cy - 44})"/>
    </g>`;
  return { title: '2. Clay 黏土', desc: '圆润哑光的黏土块，柔和的投影，可爱、可触摸。', bg, defs, inner };
})();

// ---------- 3. Blueprint 蓝图 ----------
VARIANTS.blueprint = (() => {
  const defs = `
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 H 0 V 32" fill="none" stroke="#7dd3fc" stroke-opacity=".16" stroke-width="1"/>
    </pattern>`;
  const bg = `<rect width="${S}" height="${S}" fill="#0a2540"/><rect width="${S}" height="${S}" fill="url(#grid)"/>`;
  const inner = `
    <g fill="none" stroke="#7dd3fc" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".95">
      <path d="${head()}"/><path d="${bust()}"/>${waveArcs(5)}${monitor(5)}
    </g>
    <g stroke="#e0f2fe" stroke-opacity=".5" stroke-width="2" stroke-dasharray="8 8">
      <path d="M ${HEAD.cx - HEAD.r} 100 H ${HEAD.cx + HEAD.r}"/>
      <path d="M ${MON.x} 92 H ${MON.x + MON.w}"/>
      <path d="M 60 ${S - 70} H 460"/>
    </g>
    <g fill="#e0f2fe" font-family="Consolas, monospace" font-size="20" opacity=".75">
      <text x="60" y="92">HUMAN</text>
      <text x="352" y="84">TERMINAL</text>
      <text x="150" y="${S - 48}">VOICE → ACTION</text>
    </g>`;
  return { title: '3. Blueprint 蓝图', desc: '深蓝图纸 + 网格 + 细白线 + 标注，像一张工程图。', bg, defs, inner };
})();

// ---------- 4. 16-bit 像素 ----------
VARIANTS.pixel = (() => {
  const cell = 32;
  const blocks = [];
  const add = (x, y, c = '#e2e8f0', w = 1, h = 1) => { blocks.push(`<rect x="${x * cell}" y="${y * cell}" width="${w * cell - 4}" height="${h * cell - 4}" fill="${c}"/>`); };
  // 人：头（圆形近似方）
  add(0, 4, '#e2e8f0', 3, 1); add(0, 5, '#e2e8f0', 3, 1); add(0, 6, '#e2e8f0', 3, 1);
  // 肩
  add(0, 8, '#e2e8f0', 4, 1); add(0, 9, '#e2e8f0', 5, 1); add(0, 10, '#e2e8f0', 5, 1);
  // 声波（三段，向外）
  for (let i = 0; i < 3; i += 1) {
    add(5 + i, 4 + i, '#22d3ee', 1, 3 - i); add(6 + i, 3 + i, '#22d3ee', 1, 1);
  }
  // 电脑
  add(10, 3, '#f472b6', 5, 1); add(10, 4, '#f472b6', 1, 3); add(14, 4, '#f472b6', 1, 3);
  add(10, 7, '#f472b6', 5, 1); add(9, 8, '#f472b6', 7, 1);
  const bg = `<rect width="${S}" height="${S}" fill="#141420"/>`;
  const inner = `<g>${blocks.join('')}</g>`;
  const defs = '';
  return { title: '4. 16-bit 像素', desc: '方块像素风，复古游戏机气质；轮廓用像素近似。', bg, defs, inner };
})();

// ---------- 5. Sticker 贴纸 ----------
VARIANTS.sticker = (() => {
  const defs = `
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#fdba74"/></linearGradient>
    <filter id="stickerShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#7c2d12" flood-opacity=".45"/>
    </filter>`;
  const bg = `<rect width="${S}" height="${S}" fill="url(#bg)"/>
    <g fill="#ffffff" opacity=".35"><circle cx="90" cy="90" r="46"/><circle cx="432" cy="140" r="26"/><circle cx="420" cy="430" r="34"/></g>`;
  const inner = `
    <g filter="url(#stickerShadow)" stroke="#ffffff" stroke-width="40" stroke-linejoin="round" stroke-linecap="round">
      <g fill="#111827"><path d="${head()}"/><path d="${bust()}"/><rect x="${MON.x}" y="${MON.y}" width="${MON.w}" height="${MON.h}" rx="26"/></g>
      <g fill="none" stroke="#f472b6" stroke-width="34" stroke-linecap="round">${waveArcs(34)}</g>
    </g>
    <g fill="none" stroke="#111827" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
      <path d="${head()}"/><path d="${bust()}"/>${waveArcs(26)}${monitor(26)}
    </g>`;
  return { title: '5. Sticker 贴纸', desc: '粗白描边 + 投影 + 亮底，像贴在屏幕上的贴纸。', bg, defs, inner };
})();

// ---------- 6. Neon 霓虹灯管 ----------
VARIANTS.neon = (() => {
  const defs = `
    <linearGradient id="tube" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/></linearGradient>
    <filter id="bloom" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="16" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
  const bg = `<rect width="${S}" height="${S}" fill="#05010d"/>
    <rect x="20" y="20" width="${S - 40}" height="${S - 40}" rx="100" fill="none" stroke="#2a1b4d" stroke-width="6"/>`;
  const inner = `
    <g filter="url(#bloom)" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="url(#tube)" stroke-width="30"><path d="${head()}"/><path d="${bust()}"/>${waveArcs(30)}${monitor(30)}</g>
      <g stroke="#ffffff" stroke-width="10" opacity=".85"><path d="${head()}"/><path d="${bust()}"/>${waveArcs(10)}${monitor(10)}</g>
    </g>`;
  return { title: '6. Neon 灯管', desc: '霓虹灯管 + 强辉光，夜里当招牌用。', bg, defs, inner };
})();

function render(v) { return wrap(v.bg, v.defs, v.inner); }

function previewHtml() {
  const cards = Object.entries(VARIANTS).map(([k, v]) => `
    <div class="card"><img class="big" src="out/${k}.svg"><div class="cap"><b>${v.title}</b><p>${v.desc}</p></div></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#fbfbfd;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#1b1f27}
  .wrap{padding:22px 30px 34px}
  h1{font-size:19px;margin:0 0 4px;font-weight:650}
  .sub{font-size:12.5px;color:#667;margin:0 0 16px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px 26px}
  .card{display:flex;flex-direction:column;gap:6px}
  .big{width:100%;aspect-ratio:1;display:block;filter:drop-shadow(0 10px 22px rgba(20,30,60,.2))}
  .cap b{font-size:13.5px}.cap p{margin:2px 0 0;font-size:11px;color:#5a6274;line-height:1.4}
  </style></head><body><div class="wrap">
  <h1>VoiceKeys 图标 · 第四十一轮：位置不变，六种风格差异拉满</h1>
  <p class="sub">布局锁死：左人 → 中声波 → 右电脑。风格参考 2026 图标趋势（Liquid Glass / Clay / Blueprint / Pixel / Sticker / Neon）。</p>
  <div class="grid">${cards}</div>
  </div></body></html>`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [k, v] of Object.entries(VARIANTS)) {
  fs.writeFileSync(path.join(OUT, k + '.svg'), render(v), 'utf8');
}
fs.writeFileSync(path.join(__dirname, 'preview.html'), previewHtml(), 'utf8');
console.log('  generated ' + Object.keys(VARIANTS).length + ' style variants + preview.html');
