/**
 * brand.js — 「灵感改装 / Inspire Car」品牌标识
 *
 * 三个挂载点：
 *   1. 侧栏顶部       variant: 'sidebar'   图标 + 中英文标
 *   2. 3D 视口水印     variant: 'watermark' 右下角半透明，不挡看车
 *   3. 加载遮罩居中     variant: 'overlay'   完整 logo 图（图标+名称），模型加载时显示
 *
 * 图标与完整 logo 均来自用户上传的品牌图，经裁剪/压缩后放在 src/assets。
 * 不依赖任何外网 CDN，避免本机透明代理导致资源空白。
 */

import './brand.css';
import logoIconUrl from '../assets/logo-icon.png';
import logoFullUrl from '../assets/logo-full.png';

/** 品牌名（改这里就能全局换字） */
export const BRAND = {
  title: 'INSPIRE CAR',
  sub: '灵感车库 · Tuning Studio',
};

/** 默认图标资源 */
export const LOGO_ICON = logoIconUrl;
/** 完整 logo 资源（含图标+名称，用于加载遮罩） */
export const LOGO_FULL = logoFullUrl;

/**
 * 生成图片图标 HTML。
 *
 * @param {number} size 边长（px）
 * @param {string} src  图片地址
 * @param {string} alt  无障碍文本
 */
export function brandIconImg(size = 40, src = LOGO_ICON, alt = BRAND.title) {
  return `
<img class="jg-icon" width="${size}" height="${size}" src="${src}" alt="${alt}"
     draggable="false" decoding="async"/>`;
}

/**
 * 生成品牌标识 DOM。
 *
 * @param {object} o
 * @param {'sidebar'|'watermark'|'overlay'} [o.variant='sidebar']
 * @param {number} [o.size=40] 图标边长 px
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
  const src = iconSrc || (variant === 'overlay' ? LOGO_FULL : LOGO_ICON);
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
  const el = createBrand({ variant: 'sidebar', size: 40, ...opts });
  sidebar.prepend(el);
  return el;
}

/** 挂到 3D 视口右下角做水印 */
export function mountViewportWatermark(stage, opts = {}) {
  if (!stage || stage.querySelector('.jg-brand--watermark')) return null;
  const el = createBrand({ variant: 'watermark', size: 30, ...opts });
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
