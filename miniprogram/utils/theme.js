// utils/theme.js — 共享配色常量（在 JS 里构造动态样式 / 占位图时用）
// WXML/WXSS 里请直接用全局 app.wxss 的 CSS 变量与 class。
const THEME = {
  bg: '#0b0e13',
  panel: '#121722',
  text: '#e8edf3',
  muted: '#7b8794',
  cyan: '#3ee4ff',   // 霓虹青（主色）
  magenta: '#ff30d6', // 品红（强调）
  violet: '#a85cff',  // 紫（渐变过渡）
};

/** 生成一张占位渐变图（data URI），用于方案封面缺图时的兜底 */
function placeholderDataUri(label) {
  const text = encodeURIComponent(label || 'INSPIRE CAR');
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='#0b0e13'/><stop offset='1' stop-color='#1a1030'/>` +
    `</linearGradient></defs>` +
    `<rect width='600' height='400' fill='url(#g)'/>` +
    `<text x='50%' y='52%' fill='#3ee4ff' font-size='34' font-family='sans-serif' text-anchor='middle'>${text}</text>` +
    `</svg>`;
  return 'data:image/svg+xml,' + svg;
}

export default { THEME, placeholderDataUri };
