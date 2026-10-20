/**
 * brand.js — 「灵感改装 / INSPIRE CAR」品牌标识（2026-10-20 新字标版）
 *
 * 品牌视觉基准（用户提供的 VI 基准图）：
 *   · 字标 = 定制字形 INSPIRE CAR（白色，透明底，宽高比 19.3:1，极扁宽）
 *   · 标语 = MODIFY × EXPLORE × BEYOND（宽字距小型大写）
 *
 * 挂载点：
 *   1. 侧栏顶部       variant: 'sidebar'   小号字标
 *   2. 3D 视口水印     variant: 'watermark' 右下角半透明字标，不挡看车
 *   3. 加载遮罩居中     variant: 'overlay'   大字标 + 宽字距标语，模型加载时显示
 *
 * 资源说明：由用户提供的白底字标图抠像而来（PIL 阈值 → alpha 通道），
 * 白色版用于深色 UI；无需 CSS filter 反相。
 */

import './brand.css';
import logoWordmarkWhiteUrl from '../assets/logo-wordmark-white.png';
import logoGlyphWhiteUrl from '../assets/logo-glyph-white.png';

/** 品牌名（改这里就能全局换字） */
export const BRAND = {
  title: 'INSPIRE CAR',
  sub: '灵感改装 · Tuning Studio',
  tagline: 'MODIFY × EXPLORE × BEYOND',
};

/** 字标（白，透明底）—— 深色 UI 直接使用 */
export const LOGO_WORDMARK = logoWordmarkWhiteUrl;
/** 品牌字形（IC 双字母，透明底）—— favicon / 进度标记等小图标位 */
export const LOGO_GLYPH = logoGlyphWhiteUrl;

/* 历史别名：旧徽标资源已退役，统一指向新字标，避免破坏旧引用 */
export const LOGO_MARK = logoWordmarkWhiteUrl;
export const LOGO_FULL = logoWordmarkWhiteUrl;

/** 字标固有宽高比（width / height）= 1546 / 80 */
const WORDMARK_ASPECT = 1546 / 80;

/** 按视觉高度换算渲染宽度（字标极扁宽，必须显式定宽防拉伸/挤压） */
function widthFor(height) {
  return Math.round(height * WORDMARK_ASPECT);
}

/**
 * 生成字标 <img>。
 *
 * @param {object} o
 * @param {number} [o.height=12] 视觉高度 px
 * @param {string} [o.src] 图片地址
 * @param {string} [o.className] 附加类名（如 jg-wordmark--overlay 走 CSS 自适应宽）
 */
function wordmarkImg({ height = 12, src = LOGO_WORDMARK, className = '' } = {}) {
  const cls = className ? ` ${className}` : '';
  return `<img class="jg-wordmark${cls}" width="${widthFor(height)}" height="${height}" src="${src}" alt="${BRAND.title}" draggable="false" decoding="async"/>`;
}

/**
 * 生成品牌标识 DOM。
 *
 * @param {object} o
 * @param {'sidebar'|'watermark'|'overlay'} [o.variant='sidebar']
 * @returns {HTMLElement}
 */
export function createBrand({ variant = 'sidebar' } = {}) {
  const el = document.createElement('div');
  el.className = `jg-brand jg-brand--${variant}`;

  if (variant === 'overlay') {
    // 加载遮罩：大字标 + 宽字距标语（尺寸交给 CSS 做 vw 自适应）
    el.innerHTML = `
      ${wordmarkImg({ height: 24, className: 'jg-wordmark--overlay' })}
      <span class="jg-brand__tagline">${BRAND.tagline.replace(/×/g, '<i>×</i>')}</span>`;
    return el;
  }

  // 侧栏 / 水印：小号字标
  el.innerHTML = wordmarkImg({ height: variant === 'watermark' ? 9 : 11 });
  return el;
}

/** 挂到侧栏顶部（插到最前面） */
export function mountSidebarBrand(sidebar, opts = {}) {
  if (!sidebar || sidebar.querySelector('.jg-brand--sidebar')) return null;
  const el = createBrand({ variant: 'sidebar', ...opts });
  sidebar.prepend(el);
  return el;
}

/** 挂到 3D 视口右下角做水印 */
export function mountViewportWatermark(stage, opts = {}) {
  if (!stage || stage.querySelector('.jg-brand--watermark')) return null;
  const el = createBrand({ variant: 'watermark', ...opts });
  stage.appendChild(el);
  return el;
}

/** 挂到加载遮罩里，插在最前面（字标 + 标语在上，spinner 与文案在下） */
export function mountOverlayBrand(overlay, opts = {}) {
  if (!overlay || overlay.querySelector('.jg-brand--overlay')) return null;
  const el = createBrand({ variant: 'overlay', ...opts });
  overlay.prepend(el);
  return el;
}

/** 一次性挂满三处 */
export function mountBrandAll({ sidebar, stage, overlay } = {}) {
  return {
    sidebar: sidebar ? mountSidebarBrand(sidebar) : null,
    watermark: stage ? mountViewportWatermark(stage) : null,
    overlay: overlay ? mountOverlayBrand(overlay) : null,
  };
}
