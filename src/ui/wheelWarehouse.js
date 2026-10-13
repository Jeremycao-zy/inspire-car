/**
 * wheelWarehouse.js — 首页「轮毂仓库」（全新主从式设计）
 *
 * 展示逻辑（相较旧版「横向缩略图条 + 舞台」完全重做）：
 *   · 顶部：标题 + 副标题 + 数量徽章（共 N 款）。
 *   · 有轮毂 → 主从两栏：
 *       - 左侧「展示台」：大图 3D 全息实时预览当前选中轮毂 + 名称 + 操作（删除 / 装到当前车）。
 *       - 右侧「卡片网格」：响应式网格陈列所有已拥有轮毂，点击切换展示台预览，选中态青色高亮。
 *   · 无轮毂 → 全新空状态卡：轮毂图标 + 文案 + 「去生成轮毂」入口。
 *
 * 数据：server 端 /api/wheels（账户绑定）。生成成功后 main.js 广播 mywheel:added 即时刷新。
 * dispose() 必须被首页 teardown 调用——释放唯一的 WebGL 上下文（iOS 友好）。
 */

import './wheelWarehouse.css';
import { listWheels, removeWheel } from '../api/wheels.js';
import { createWheelHolo } from './wheelHolo.js';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'onclick' || k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/**
 * @param {{onEquip?:(url:string)=>void, onNewWheel?:()=>void}} opts
 * @returns {{el:HTMLElement, refresh:Function, pause:Function, resume:Function, dispose:Function}}
 */
export function mountWheelWarehouse({ onEquip, onNewWheel } = {}) {
  const section = h('section', { class: 'garage-wheels' });

  /* 头部：标题 + 副标题 + 数量徽章 */
  const countBadge = h('span', { class: 'gw-count' }, '0 款');
  const head = h(
    'div',
    { class: 'gw-head' },
    h(
      'div',
      { class: 'gw-head__text' },
      h('h2', { class: 'garage-section-title' }, '轮毂仓库'),
      h('p', { class: 'gw-sub' }, '已拥有的轮毂，随时悬空选装到任意车')
    ),
    countBadge
  );

  /* 展示台：大图 3D 全息 + 名称 + 操作 */
  const previewCanvas = h('div', { class: 'gw-preview__canvas' });
  const previewName = h('div', { class: 'gw-preview__name' }, '—');
  const previewMeta = h('div', { class: 'gw-preview__meta' }, '● 3D 实时预览');
  const equipBtn = h('button', { class: 'gw-preview__equip', onclick: () => equip() }, '装到当前车');
  const delBtn = h(
    'button',
    { class: 'gw-preview__del', title: '删除此轮毂', 'aria-label': '删除此轮毂', onclick: () => removeSelected() },
    '删除'
  );
  const preview = h(
    'div',
    { class: 'gw-preview' },
    previewCanvas,
    h(
      'div',
      { class: 'gw-preview__bar' },
      h('div', { class: 'gw-preview__info' }, previewName, previewMeta),
      h('div', { class: 'gw-preview__actions' }, delBtn, equipBtn)
    )
  );

  /* 轮毂卡片网格 */
  const grid = h('div', { class: 'gw-grid' });

  /* 空状态 */
  const empty = h(
    'div',
    { class: 'gw-empty' },
    h('div', {
      class: 'gw-empty__icon',
      html:
        '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>' +
        '<path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M5.6 5.6l2.5 2.5M15.9 15.9l2.5 2.5M18.4 5.6l-2.5 2.5M8.1 15.9l-2.5 2.5"/></svg>',
    }),
    h('h3', { class: 'gw-empty__title' }, '还没有轮毂'),
    h('p', { class: 'gw-empty__hint' }, '去工作室生成你的第一款轮毂，它会出现在这里，随时换装到任意车'),
    h('button', {
      class: 'gw-empty__cta',
      onclick: () => {
        if (typeof onNewWheel === 'function') onNewWheel();
      },
    }, '去生成轮毂 →')
  );

  const body = h('div', { class: 'gw-body' }, preview, grid);
  section.appendChild(head);
  section.appendChild(body);
  section.appendChild(empty);

  let holo = null;
  let wheels = [];
  let selected = null;

  function equip() {
    if (!selected?.url) return;
    if (typeof onEquip === 'function') onEquip(selected.url);
  }

  async function removeSelected() {
    if (!selected?.id) return;
    if (!window.confirm(`确定删除「${selected.name || '我的轮毂'}」？此操作不可撤销。`)) return;
    await removeWheel(selected.id);
    selected = null;
    await refresh();
  }

  function selectWheel(w) {
    selected = w;
    previewName.textContent = w.name || '我的轮毂';
    grid.querySelectorAll('.gw-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.id === w.id);
    });
    if (holo) holo.setWheel(w.url);
  }

  async function refresh() {
    wheels = await listWheels();
    countBadge.textContent = `${wheels.length} 款`;
    grid.innerHTML = '';
    if (!wheels.length) {
      empty.style.display = '';
      body.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    body.style.display = '';
    for (const w of wheels) {
      const thumb = w.thumb
        ? h('img', { class: 'gw-card__img', src: w.thumb, alt: w.name || '', loading: 'lazy' })
        : h('div', { class: 'gw-card__noimg' }, '轮毂');
      const card = h(
        'div',
        { class: 'gw-card', 'data-id': w.id, title: '点击预览', onclick: () => selectWheel(w) },
        h('div', { class: 'gw-card__thumb' }, thumb),
        h('div', { class: 'gw-card__name' }, w.name || '我的轮毂')
      );
      grid.appendChild(card);
    }
    // 保留仍存在的选中项，否则默认选第一个
    const stillThere = selected && wheels.find((w) => w.id === selected.id);
    selectWheel(stillThere || wheels[0]);
  }

  // 等 DOM 进入文档后拿到尺寸再建 WebGL（避免 0×0）
  let started = false;
  function startHolo() {
    if (started) return;
    started = true;
    holo = createWheelHolo(previewCanvas);
    refresh();
  }
  requestAnimationFrame(startHolo);

  function onWheelAdded() {
    refresh();
  }
  window.addEventListener('mywheel:added', onWheelAdded);

  return {
    el: section,
    refresh,
    pause() {
      holo?.pause();
    },
    resume() {
      holo?.resume();
    },
    dispose() {
      window.removeEventListener('mywheel:added', onWheelAdded);
      if (holo) {
        holo.dispose();
        holo = null;
      }
    },
  };
}
