/**
 * theme.js — 浅色 / 深色 / 跟随系统 三态主题
 *
 * 设计：
 *  - 默认 auto：跟随系统 prefers-color-scheme（用户无感知自动切换）；
 *  - 用户点过切换按钮 → 写显式偏好（localStorage 'ic-theme' = 'light' | 'dark'），
 *    此后不再跟随系统，直到……没有"恢复自动"的 UI，保持简单：按钮只在深浅之间切换。
 *  - 应用方式：html[data-theme="light"]，所有覆盖规则在 theme.css；
 *  - favicon 联动：品牌资产有深浅两套（public/icons/favicon-* 与 favicon-light-*）。
 *
 * 防闪白：index.html <head> 里有一段内联脚本在首绘前就设好 data-theme，
 * 本模块只负责运行时监听与按钮。
 */

import './theme.css';

const KEY = 'ic-theme';
const mq = window.matchMedia('(prefers-color-scheme: light)');

function readPref() {
  try {
    return localStorage.getItem(KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

function resolve(pref) {
  return pref === 'auto' ? (mq.matches ? 'light' : 'dark') : pref;
}

/** 当前生效的主题（'light' | 'dark'） */
export function currentTheme() {
  return resolve(readPref());
}

/** 切到显式偏好并应用 */
export function setTheme(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme();
}

/** 深浅互换（按钮用） */
export function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
}

function swapFavicon(theme) {
  document.querySelectorAll('link[rel="icon"]').forEach((l) => {
    const href = l.getAttribute('href') || '';
    const m = /favicon-(light-)?(\d+)\.png/.exec(href);
    if (!m) return;
    l.href = theme === 'light' ? `/icons/favicon-light-${m[2]}.png` : `/icons/favicon-${m[2]}.png`;
  });
}

function applyTheme() {
  const t = currentTheme();
  document.documentElement.dataset.theme = t;
  swapFavicon(t);
}

/** 启动：应用当前主题 + auto 模式下监听系统变化 */
export function initTheme() {
  applyTheme();
  if (mq.addEventListener) {
    mq.addEventListener('change', () => {
      if (readPref() === 'auto') applyTheme();
    });
  }
}

/* ---------------- 切换按钮 ---------------- */

const ICON_SUN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.1M12 19.4v2.1M2.5 12h2.1M19.4 12h2.1M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5"/></svg>';
const ICON_MOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 14.2A8.6 8.6 0 1 1 9.8 3.4a7 7 0 0 0 10.8 10.8z"/></svg>';

/**
 * 在容器内渲染主题切换按钮。
 * @param {HTMLElement} container 挂载点（如 header 右侧区 / 工作室面板头）
 * @returns {HTMLElement|null} 按钮元素
 */
export function mountThemeToggle(container) {
  if (!container) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  btn.title = '切换浅色 / 深色';
  btn.setAttribute('aria-label', '切换浅色 / 深色');
  const render = () => {
    const light = currentTheme() === 'light';
    // 浅色模式下显示月亮（接下来会去深色），深色模式显示太阳
    btn.innerHTML = light ? ICON_MOON : ICON_SUN;
    btn.dataset.state = light ? 'light' : 'dark';
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTheme();
    render();
  });
  render();
  container.appendChild(btn);
  return btn;
}
