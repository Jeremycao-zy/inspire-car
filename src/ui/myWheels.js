/**
 * myWheels.js — 「我的轮毂」库
 *
 * 逻辑：
 *   · 用户每次成功生成（live）轮毂，把模型 URL + 上传照片缩略图 + 名称存进 localStorage。
 *   · 库是用户级别的（key 按 userId），不随方案切换而丢失。
 *   · 在「轮毂」Tab 下渲染成可横向滚动的卡片列表；点击卡片即把该轮毂换到当前车上。
 *   · 每个方案只保存「当前用哪套轮毂」（customWheelUrl + rimPreset='custom'），
 *     因此不同车库卡片可以装载不同轮毂。
 */

import './myWheels.css';
import { currentUser } from '../auth.js';

const MAX_STORED = 30;

function storageKey() {
  const u = currentUser();
  return `inspire-car-my-wheels:${u?.id || 'anon'}`;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'onclick' || k.startsWith('on')) {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      el.className = v;
    } else if (k === 'text') {
      el.textContent = v;
    } else {
      el.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string' || typeof c === 'number') {
      el.appendChild(document.createTextNode(String(c)));
    } else if (c instanceof Node) {
      el.appendChild(c);
    }
  }
  return el;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function getMyWheels() {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('[myWheels] 读取失败', e.message);
    return [];
  }
}

function setMyWheels(list) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(list));
  } catch (e) {
    console.warn('[myWheels] 保存失败', e.message);
  }
}

export function addMyWheel({ url, name = '', thumb = '' } = {}) {
  if (!url) return null;
  const list = getMyWheels();
  // 同一 URL 不重复，移到最前
  const idx = list.findIndex((w) => w.url === url);
  if (idx >= 0) list.splice(idx, 1);
  const id = 'mw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  list.unshift({ id, url, name: name || '我的轮毂', thumb, createdAt: Date.now() });
  if (list.length > MAX_STORED) list.length = MAX_STORED;
  setMyWheels(list);
  return list[0];
}

export function removeMyWheel(id) {
  const list = getMyWheels().filter((w) => w.id !== id);
  setMyWheels(list);
}

/**
 * 把生成结果记录到「我的轮毂」并清空上传区，方便用户继续上传下一张。
 * @param {{url:string, files?:File[], name?:string}}
 * @returns {Promise<object|null>}
 */
export async function recordGeneratedWheel({ url, files = [], name = '' } = {}) {
  if (!url) return null;
  let thumb = '';
  if (files && files[0]) {
    try {
      thumb = await fileToDataURL(files[0]);
    } catch (e) {
      console.warn('[myWheels] 缩略图生成失败', e.message);
    }
  }
  return addMyWheel({ url, name, thumb });
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * 渲染「我的轮毂」列表。
 * @param {HTMLElement} container
 * @param {{app:object, activeUrl?:string|null}} opts
 */
export function renderMyWheels(container, { app, activeUrl = null } = {}) {
  if (!container) return;
  container.innerHTML = '';
  const list = getMyWheels();
  if (!list.length) {
    container.appendChild(
      h('div', { class: 'myw-empty' }, '上传轮毂照片生成后，你的轮毂会出现在这里，可随时换装。')
    );
    return;
  }

  const grid = h('div', { class: 'myw-grid' });
  for (const w of list) {
    const isActive = activeUrl === w.url;
    const imgWrap = h('div', { class: 'myw-img-wrap' });
    if (w.thumb) {
      imgWrap.appendChild(h('img', { src: w.thumb, alt: w.name }));
    } else {
      imgWrap.appendChild(h('div', { class: 'myw-noimg', text: '轮毂' }));
    }

    const nameEl = h('div', { class: 'myw-name', text: w.name });
    const dateEl = h('div', { class: 'myw-date', text: fmtDate(w.createdAt) });

    const delBtn = h(
      'button',
      {
        class: 'myw-del',
        title: '删除',
        onclick: (e) => {
          e.stopPropagation();
          removeMyWheel(w.id);
          renderMyWheels(container, { app, activeUrl });
        },
      },
      '×'
    );

    const card = h(
      'div',
      {
        class: `myw-card ${isActive ? 'active' : ''}`,
        title: '点击换装',
        onclick: async () => {
          if (!app?.loadWheelFromUrl) return;
          // 写入方案参数：当前车使用这套自定义轮毂
          app.params.customWheelUrl = w.url;
          app.params.rimPreset = 'custom';
          await app.loadWheelFromUrl(w.url);
          // 刷新列表高亮
          renderMyWheels(container, { app, activeUrl: w.url });
          // 通知面板同步（预设按钮取消高亮等）
          window.dispatchEvent(new CustomEvent('mywheel:installed', { detail: { url: w.url } }));
        },
      },
      imgWrap,
      h('div', { class: 'myw-info' }, nameEl, dateEl),
      delBtn
    );
    grid.appendChild(card);
  }
  container.appendChild(grid);
}
