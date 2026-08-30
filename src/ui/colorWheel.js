/**
 * colorWheel.js — HSV 色轮改色控件（车漆）
 *
 * 圆形色轮：角度 = 色相 H，半径 = 饱和度 S；下方滑杆 = 明度 V。
 * 默认「着色叠加」（保留车身原贴图，色轮色与贴图乘算）；
 * 切到「纯色喷漆」开关则去掉 baseColor 贴图，整车变纯色车漆。
 *
 * onChange(hex, { solid }) 每次选色实时回调；set(hex, solid) 供方案恢复同步（不回调）。
 */

/* ---------------------------- 颜色工具 ---------------------------- */

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max < 1e-9 ? 0 : d / max;
  return [h, s, max];
}

function toHex(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/* ---------------------------- DOM 小工具 ---------------------------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('style') && typeof v === 'string') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/* ---------------------------- 组件 ---------------------------- */

export function createColorWheel({ value = '#c8102e', solid = false, onChange } = {}) {
  const SIZE = 220;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const maxR = SIZE / 2 - 2;

  /* 色轮画布 */
  const canvas = el('canvas', { class: 'cw-wheel', width: String(SIZE), height: String(SIZE) });
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx,
        dy = y - cy;
      const r = Math.hypot(dx, dy);
      const idx = (y * SIZE + x) * 4;
      if (r > maxR) {
        img.data[idx + 3] = 0;
        continue;
      }
      let h = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (h < 0) h += 360;
      const s = Math.min(1, r / maxR);
      const [rr, gg, bb] = hsvToRgb(h, s, 1);
      img.data[idx] = rr * 255;
      img.data[idx + 1] = gg * 255;
      img.data[idx + 2] = bb * 255;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const marker = el('div', { class: 'cw-marker' });
  const wheelWrap = el('div', { class: 'cw-wheel-wrap' }, canvas, marker);

  /* 明度滑杆 + 当前色值 */
  const bright = el('input', { type: 'range', class: 'cw-bright', min: '0', max: '100', step: '1' });
  const hexText = el('span', { class: 'cw-hex' }, value);
  const brightRow = el(
    'div',
    { class: 'cw-bright-row' },
    el('span', { class: 'cw-bright-label' }, '明度'),
    bright,
    hexText
  );

  /* 预设色板 */
  const PRESETS = [
    ['#c8102e', '竞速红'],
    ['#f2f3f5', '极地白'],
    ['#111418', '曜石黑'],
    ['#15355e', '深海蓝'],
    ['#6b7178', '钛金灰'],
    ['#d8b13a', '沙漠黄'],
    ['#2fd06a', '荧光绿'],
    ['#e8590c', '熔岩橙'],
    ['#6f3fd0', '星云紫'],
    ['#2b2f36', '哑光黑'],
  ];
  const swatches = el('div', { class: 'cw-swatches' });
  for (const [c, name] of PRESETS) {
    swatches.appendChild(
      el('button', {
        class: 'cw-swatch',
        title: name,
        'aria-label': name,
        style: `background:${c}`,
        onclick: () => applyHex(c),
      })
    );
  }

  /* 纯色喷漆开关 */
  const solidChk = el('input', { type: 'checkbox' });
  solidChk.checked = !!solid;
  solidChk.addEventListener('change', () => emit());
  const solidRow = el(
    'label',
    { class: 'switch cw-solid' },
    solidChk,
    el('span', {}, '纯色喷漆（覆盖原车贴图）')
  );

  const resetBtn = el(
    'button',
    { class: 'btn ghost small', onclick: () => applyHex('#c8102e') },
    '还原默认色'
  );

  /* 状态 */
  let curH = 0,
    curS = 0,
    curV = 1;

  function placeMarker() {
    const ang = (curH * Math.PI) / 180;
    const rad = curS * maxR;
    marker.style.left = `${cx + rad * Math.cos(ang)}px`;
    marker.style.top = `${cy + rad * Math.sin(ang)}px`;
  }

  function emit() {
    const hex = toHex(...hsvToRgb(curH, curS, curV));
    hexText.textContent = hex;
    onChange?.(hex, { solid: solidChk.checked });
  }

  function applyHex(hex, doEmit = true) {
    const [r, g, b] = hexToRgb(hex);
    const [h, s, v] = rgbToHsv(r, g, b);
    curH = h;
    curS = s;
    curV = v;
    bright.value = String(Math.round(v * 100));
    placeMarker();
    hexText.textContent = hex;
    if (doEmit) emit();
  }

  function setFromWheel(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const dx = x - cx,
      dy = y - cy;
    const r = Math.hypot(dx, dy);
    let h = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (h < 0) h += 360;
    const s = Math.min(1, r / maxR);
    curH = h;
    curS = s;
    placeMarker();
    emit();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    setFromWheel(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) setFromWheel(e.clientX, e.clientY);
  });
  bright.addEventListener('input', () => {
    curV = parseInt(bright.value, 10) / 100;
    emit();
  });

  // 初始色值（不回调，避免覆盖外部已设好的状态）
  applyHex(value, false);
  hexText.textContent = value;

  const root = el(
    'div',
    { class: 'cw' },
    wheelWrap,
    brightRow,
    swatches,
    solidRow,
    el('div', { class: 'btn-row' }, resetBtn)
  );

  return {
    root,
    /** 方案恢复时同步色轮显示（不触发 onChange） */
    set(hex, s) {
      solidChk.checked = !!s;
      applyHex(hex, false);
    },
  };
}
