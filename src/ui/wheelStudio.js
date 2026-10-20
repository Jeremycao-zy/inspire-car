/**
 * wheelStudio.js — 「轮毂工坊 · WHEEL STUDIO」拍摄台（轮毂生成页专用视觉）
 *
 * 与车模拍摄引导（photoGuide）**刻意使用两套不同的视觉语言**：
 *   · 车模页 = 矩形相机取景框（镜头 / 快门 / 虚线安全框隐喻）
 *   · 轮毂页 = 回转体工程台（转盘刻度 + 中心十字 + 规格清单 + 透明底产品件）
 *     轮毂是回转体，用「圆 / 刻度 / 尺寸线」表达比用相机取景框更贴切，
 *     也让用户在两个生成流程之间一眼分得清。
 *
 * 组件对外接口与旧实现完全一致：{ stage, advance, showShot, reset }，
 * panel.js 的调用方行为不变（拍完自动切下一角度、点清单可回看、生成完成重置）。
 */

import './wheelStudio.css';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'value' && 'value' in node) node.value = v;
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false)
      node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * 构建轮毂拍摄台。
 *
 * @param {{items: Array<{label:string, code?:string, img:string, desc:string, shot?:string}>}} guide
 *        角度定义。img = 示意图（透明底产品件），shot = 实拍图覆盖。
 * @param {HTMLElement} thumbs 复用主上传区的缩略图容器（按选择顺序一一对应角度）
 * @returns {{stage:HTMLElement, advance:Function, showShot:Function, reset:Function}}
 */
export function buildWheelStudio(guide, thumbs, { title = '', hint = '' } = {}) {
  const items = guide.items || [];
  const len = items.length;

  /* ---------------- 顶部：工坊标识 + 进度 ---------------- */
  const progressNum = el('span', { class: 'ws-progress__num' });
  const progressFill = el('i', { class: 'ws-progress__fill' });
  const head = el(
    'header',
    { class: 'ws-head' },
    el(
      'div',
      { class: 'ws-mark' },
      el('span', { class: 'ws-mark__glyph', 'aria-hidden': 'true' }),
      el(
        'div',
        { class: 'ws-mark__text' },
        el('span', { class: 'ws-mark__eyebrow' }, 'WHEEL STUDIO'),
        el(
          'h3',
          { class: 'ws-mark__title' },
          '轮毂拍摄工坊',
          title ? el('span', { class: 'ws-step' }, title) : null
        )
      )
    ),
    el(
      'div',
      { class: 'ws-progress' },
      progressNum,
      el('div', { class: 'ws-progress__bar' }, progressFill)
    )
  );

  /* ---------------- 左侧：转盘画布 ---------------- */
  const diagram = el('img', { class: 'ws-plate__img', alt: '轮毂示意图' });
  const shot = el('img', { class: 'ws-plate__img ws-plate__img--shot hidden', alt: '已选照片' });
  const plateTag = el('div', { class: 'ws-plate__tag' });
  const stageBox = el(
    'div',
    { class: 'ws-stage' },
    el('div', { class: 'ws-stage__grid', 'aria-hidden': 'true' }),
    el('div', { class: 'ws-stage__rings', 'aria-hidden': 'true' }),
    el('div', { class: 'ws-stage__cross', 'aria-hidden': 'true' }),
    el('div', { class: 'ws-stage__corners', 'aria-hidden': 'true' },
      el('i', { class: 'ws-corner ws-corner--tl' }),
      el('i', { class: 'ws-corner ws-corner--tr' }),
      el('i', { class: 'ws-corner ws-corner--bl' }),
      el('i', { class: 'ws-corner ws-corner--br' })
    ),
    el('div', { class: 'ws-plate' }, diagram, shot),
    plateTag,
    el('div', { class: 'ws-plate__dim', 'aria-hidden': 'true' },
      el('span', {}, 'Ø'),
      el('i', { class: 'ws-plate__dim-line' })
    )
  );

  /* ---------------- 右侧：拍摄规格清单 ---------------- */
  const listHead = el(
    'div',
    { class: 'ws-list__head' },
    el('span', { class: 'ws-list__title' }, '拍摄角度'),
    el('span', { class: 'ws-list__code' }, 'SHOT LIST')
  );
  const specRows = items.map((item, i) =>
    el(
      'button',
      { type: 'button', class: 'ws-item', 'data-idx': String(i) },
      el('span', { class: 'ws-item__no' }, String(i + 1).padStart(2, '0')),
      el(
        'span',
        { class: 'ws-item__body' },
        el(
          'span',
          { class: 'ws-item__label' },
          item.label,
          el('i', { class: 'ws-item__code' }, item.code || '')
        ),
        el('span', { class: 'ws-item__desc' }, item.desc)
      ),
      el('span', { class: 'ws-item__state' }, '待拍')
    )
  );
  const list = el('div', { class: 'ws-list' }, listHead, ...specRows);

  /* ---------------- 底部：拍摄动作 ---------------- */
  const cta = el('button', { type: 'button', class: 'ws-cta' }, '拍照或选相册');
  const ctaHint = el('span', { class: 'ws-cta__hint' }, '或把照片拖进来');
  const foot = el('footer', { class: 'ws-foot' },
    el('div', { class: 'ws-foot__actions' }, cta, ctaHint),
    el('span', { class: 'ws-foot__note' }, '拍完自动切到下一角度')
  );

  const stage = el(
    'div',
    { class: 'ws-studio' },
    head,
    hint ? el('p', { class: 'ws-hint' }, hint) : null,
    el('div', { class: 'ws-body' }, stageBox, list),
    foot
  );

  /* ---------------- 状态逻辑（与旧实现语义一致）---------------- */
  let count = 0;            // 已选数量高水位：只增不减
  let preview = 0;          // 当前预览角度
  const activeIdx = () => Math.min(count, len - 1);
  const doneCount = () => Math.min(count, len);

  function showAngle(i) {
    preview = Math.max(0, Math.min(i, len - 1));
    const item = items[preview];
    const thumbImg = thumbs?.children?.[preview];
    const hasShot = !!(thumbImg && thumbImg.getAttribute('src'));
    if (hasShot) {
      shot.src = thumbImg.src;
      shot.classList.remove('hidden');
    } else {
      shot.removeAttribute('src');
      shot.classList.add('hidden');
    }
    if (item) {
      diagram.src = item.img;
      const code = item.code ? ' · ' + item.code : '';
      plateTag.textContent = `SHOT ${String(preview + 1).padStart(2, '0')}${code}`;
    }
    specRows.forEach((row, j) => {
      const state = row.querySelector('.ws-item__state');
      row.classList.toggle('is-current', j === activeIdx() && count < len);
      row.classList.toggle('is-done', j < doneCount());
      row.classList.toggle('is-preview', j === preview);
      if (state) {
        state.textContent = j < doneCount() ? '已拍' : j === activeIdx() && count < len ? '待拍' : '待拍';
        state.classList.toggle('is-done', j < doneCount());
      }
    });
    const cur = Math.min(count + 1, len);
    progressNum.innerHTML = `${String(cur).padStart(2, '0')}<i>/</i>${String(len).padStart(2, '0')}`;
    progressFill.style.width = `${(doneCount() / len) * 100}%`;
  }

  specRows.forEach((row, i) =>
    row.addEventListener('click', (e) => {
      e.stopPropagation(); // 切角度 ≠ 选图
      showAngle(i);
    })
  );

  showAngle(0);

  return {
    stage,
    /** 选图后推进高水位，并跳回当前要拍的角度 */
    advance(n) {
      if (n > count) count = n;
      showAngle(activeIdx());
    },
    /** 实拍缩略图就绪：刷新当前预览 */
    showShot() {
      showAngle(preview);
    },
    /** 生成完成重置：高水位归零、回到第一个角度 */
    reset() {
      count = 0;
      showAngle(0);
    },
  };
}
