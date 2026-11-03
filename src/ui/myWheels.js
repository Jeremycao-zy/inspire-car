/**
 * myWheels.js — 「我的轮毂」库（服务端账户持久化）
 *
 * 逻辑：
 *   · 用户每次成功生成（live）轮毂，把模型 URL + 上传照片缩略图 + 名称登记进
 *     服务端 /api/wheels（账户绑定；未登录回退 'anon' 共享库）。
 *   · 库是用户级别的，不随方案切换而丢失，可在「轮毂仓库」与「工作室-轮毂 Tab」共用。
 *   · 在「轮毂」Tab 下渲染成可横向滚动的卡片列表；点击卡片即把该轮毂换到当前车上。
 *   · 每个方案只保存「当前用哪套轮毂」（customWheelUrl），不同车库卡片可装载不同轮毂。
 *
 * 与 src/ui/wheelWarehouse.js 共用 server/wheels.mjs 这一份索引。
 */

import './myWheels.css';
import { listWheels, addWheel, removeWheel } from '../api/wheels.js';

const MAX_STORED = 30;

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

/** 取当前账户的轮毂列表 */
export async function getMyWheels() {
  return listWheels();
}

/**
 * 把一个生成好的轮毂登记进仓库（服务端去重）。
 * @returns {Promise<object|null>}
 */
export async function addMyWheel({ url, name = '', thumb = '' } = {}) {
  if (!url) return null;
  return addWheel({ url, name, thumb });
}

export async function removeMyWheel(id) {
  if (!id) return;
  await removeWheel(id);
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
 * 渲染「我的轮毂」列表（服务端来源）。
 * @param {HTMLElement} container
 * @param {{app:object, activeUrl?:string|null}} opts
 */
export async function renderMyWheels(container, { app, activeUrl = null } = {}) {
  if (!container) return;
  container.innerHTML = '';
  const list = await getMyWheels();
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

    const nameEl = h('div', { class: 'myw-name', text: w.name || '我的轮毂' });
    const dateEl = h('div', { class: 'myw-date', text: fmtDate(w.createdAt) });

    const delBtn = h(
      'button',
      {
        class: 'myw-del',
        title: '删除',
        onclick: async (e) => {
          e.stopPropagation();
          await removeMyWheel(w.id);
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
