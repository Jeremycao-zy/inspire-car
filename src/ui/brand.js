/**
 * brand.js — 「灵感改装 / Inspire Car」品牌标识
 *
 * 三个挂载点：
 *   1. 侧栏顶部       variant: 'sidebar'   图标 + 中英文标
 *   2. 3D 视口水印     variant: 'watermark' 右下角半透明，不挡看车
 *   3. 加载遮罩居中     variant: 'overlay'   完整 logo 图（图标+名称），模型加载时显示
 *
 * 品牌图来自用户上传的「黑线 + 白底 + 不透明」PNG。由于白底长在图片本身，
 * 光删掉 CSS 的 background 去不掉白框，因此资源已做成去背版（透明底 + 纯黑线）：
 * 由 scripts/make-logo-alpha.py 从 logo-full.png 生成，无需外网 CDN。
 *
 * 去背后得到两个资源：
 *   · LOGO_MARK — 只有徽标图形。侧栏 / 水印这类小尺寸用它：
 *     小尺寸下字标只有几像素高，糊成一团，且与旁边的文字品牌名重复。
 *     （顺带修掉了 logo-icon.png 把字标裁掉一半的旧问题）
 *   · LOGO_FULL — 徽标 + 字标的完整锁定。只给加载遮罩用，那里尺寸够大、字标看得清。
 *
 * 原图是纯灰度（实测所有墨迹像素 RGB 通道偏差 <= 9），所以深色背景上用
 * CSS filter: invert(1) 反相成白线是无损的，不必再准备一份白色版本。
 */

import './brand.css';
import logoMarkUrl from '../assets/logo-mark-nobg.png';
import logoFullUrl from '../assets/logo-full-nobg.png';

/** 品牌名（改这里就能全局换字） */
export const BRAND = {
  title: 'INSPIRE CAR',
  sub: '灵感改装 · Tuning Studio',
};

/** 徽标资源（只含图形，透明底 + 黑线，已裁到图形外框） */
export const LOGO_MARK = logoMarkUrl;
/** 完整 logo 资源（徽标 + 字标，透明底 + 黑线，用于加载遮罩） */
export const LOGO_FULL = logoFullUrl;

/** 去背资源的固有宽高比（width / height），用于把视觉高度换算成渲染宽度 */
const MARK_ASPECT = 353 / 324; // logo-mark-nobg.png
const FULL_ASPECT = 527 / 512; // logo-full-nobg.png

/**
 * 按视觉高度算出对应的渲染宽度。
 *
 * 去背资源已裁到图形外框、且不是正方形，所以不能再套一个正方形盒子 +
 * object-fit: contain —— 那样图形会被压小，还会留下看不见的留白把排版挤歪。
 *
 * @param {string} src 图片地址
 * @param {number} height 期望的视觉高度 px
 * @returns {number} 渲染宽度 px
 */
function widthFor(src, height) {
  return Math.round(height * (src === LOGO_FULL ? FULL_ASPECT : MARK_ASPECT));
}

/**
 * 生成图片图标 HTML。
 *
 * @param {number} height 期望的视觉高度（px）
 * @param {string} src  图片地址
 * @param {string} alt  无障碍文本
 */
export function brandIconImg(height = 40, src = LOGO_MARK, alt = BRAND.title) {
  return `
<img class="jg-icon" width="${widthFor(src, height)}" height="${height}" src="${src}" alt="${alt}"
     draggable="false" decoding="async"/>`;
}

/**
 * 生成品牌标识 DOM。
 *
 * @param {object} o
 * @param {'sidebar'|'watermark'|'overlay'} [o.variant='sidebar']
 * @param {number} [o.size=40] 图标视觉高度 px
 * @param {boolean} [o.withText=true] 是否带文字
 * @param {string} [o.iconSrc] 自定义图标地址；默认按 variant 自动选择
 * @returns {HTMLElement}
 */
export function createBrand({
  variant = 'sidebar',
  size = 40,
  withText = true,
  iconSrc,
} = {}) {
  const src = iconSrc || (variant === 'overlay' ? LOGO_FULL : LOGO_MARK);
  const el = document.createElement('div');
  el.className = `jg-brand jg-brand--${variant}`;
  el.innerHTML = `
    <span class="jg-brand__icon">${brandIconImg(size, src)}</span>
    ${
      withText && variant !== 'overlay'
        ? `<span class="jg-brand__text">
             <span class="jg-brand__title">${BRAND.title}</span>
             <span class="jg-brand__sub">${BRAND.sub}</span>
           </span>`
        : ''
    }
  `;
  return el;
}

/** 挂到侧栏顶部（插到最前面） */
export function mountSidebarBrand(sidebar, opts = {}) {
  if (!sidebar || sidebar.querySelector('.jg-brand--sidebar')) return null;
  // 20px：略高于侧栏标题的 18px 字号，图形与文字视觉齐平
  const el = createBrand({ variant: 'sidebar', size: 20, ...opts });
  sidebar.prepend(el);
  return el;
}

/** 挂到 3D 视口右下角做水印 */
export function mountViewportWatermark(stage, opts = {}) {
  if (!stage || stage.querySelector('.jg-brand--watermark')) return null;
  // 15px：略高于水印标题的 12.5px 字号
  const el = createBrand({ variant: 'watermark', size: 15, ...opts });
  stage.appendChild(el);
  return el;
}

/** 挂到加载遮罩里，插在最前面（完整 logo 在上，spinner 与文案在下） */
export function mountOverlayBrand(overlay, opts = {}) {
  if (!overlay || overlay.querySelector('.jg-brand--overlay')) return null;
  const el = createBrand({ variant: 'overlay', size: 160, ...opts });
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
