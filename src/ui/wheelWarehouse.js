/**
 * wheelWarehouse.js — 首页「轮毂仓库」
 *
 * 呈现：账户持久拥有的轮毂，以「全息感 悬空选装」的 3D 轮毂（feature 视图）+
 * 真实上传照片缩略图条（strip）展示。点击缩略图切换展示的轮毂，点「装到当前车」
 * 把该轮毂套到当前车模（由调用方 onEquip 决定落到哪辆车）。
 *
 * 数据：server 端 /api/wheels（账户绑定，未登录回退 anon）。与 src/ui/myWheels.js
 * 共享同一份服务端索引，保证「首页仓库」与「工作室轮毂 Tab」一致。
 *
 * 返回的 dispose() 必须被首页 teardown 调用——释放唯一的 WebGL 上下文（iOS 友好）。
 */

import './wheelWarehouse.css';
import { listWheels } from '../api/wheels.js';
import { createWheelHolo } from './wheelHolo.js';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'onclick' || k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/**
 * @param {{onEquip?:(url:string)=>void}} opts
 * @returns {{el:HTMLElement, dispose:()=>void}}
 */
export function mountWheelWarehouse({ onEquip } = {}) {
  const section = h('section', { class: 'garage-wheels' });
  const head = h('div', { class: 'gw-head' }, h('h2', { class: 'garage-section-title' }, '轮毂仓库'));

  const stage = h('div', { class: 'gw-stage' });
  const canvas = h('div', { class: 'gw-stage__canvas' });
  const nameEl = h('div', { class: 'gw-stage__name' }, '—');
  const equipBtn = h('button', { class: 'gw-equip', onclick: () => equip() }, '装到当前车');
  stage.appendChild(canvas);
  stage.appendChild(nameEl);
  stage.appendChild(equipBtn);

  const strip = h('div', { class: 'gw-strip' });
  const empty = h('div', { class: 'gw-empty' }, '生成轮毂后，你拥有的轮毂会出现在这里，可随时换装。');

  const body = h('div', { class: 'gw-body' }, stage, strip);
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

  function selectWheel(w) {
    selected = w;
    nameEl.textContent = w.name || '我的轮毂';
    strip.querySelectorAll('.gw-thumb').forEach((c) => {
      c.classList.toggle('active', c.dataset.id === w.id);
    });
    if (holo) holo.setWheel(w.url);
  }

  async function refresh() {
    wheels = await listWheels();
    strip.innerHTML = '';
    if (!wheels.length) {
      empty.style.display = '';
      body.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    body.style.display = '';
    for (const w of wheels) {
      const thumb = w.thumb
        ? h('img', { src: w.thumb, alt: w.name, loading: 'lazy' })
        : h('div', { class: 'gw-thumb__noimg' }, '轮毂');
      const card = h(
        'div',
        {
          class: 'gw-thumb',
          'data-id': w.id,
          title: '点击在 3D 中查看',
          onclick: () => selectWheel(w),
        },
        thumb,
        h('div', { class: 'gw-thumb__name' }, w.name || '我的轮毂')
      );
      strip.appendChild(card);
    }
    selectWheel(wheels[0]);
  }

  // 等 DOM 进入文档后拿到尺寸再建 WebGL（避免 0×0）
  let started = false;
  function startHolo() {
    if (started) return;
    started = true;
    holo = createWheelHolo(canvas);
    refresh();
  }
  requestAnimationFrame(startHolo);

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
      if (holo) {
        holo.dispose();
        holo = null;
      }
    },
  };
}
