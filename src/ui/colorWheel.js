/**
 * colorWheel.js — 车漆 HSV 色轮控件（高端车厂 configurator 风格 · 第二版）
 *
 * 圆形色轮：角度 = 色相 H，半径 = 饱和度 S；下方滑杆 = 明度 V。
 * 顶部玻璃质感预览球实时反映当前车漆色（含高光与暗部）。
 * 默认「着色叠加」（保留车身原贴图，色轮色与贴图乘算）；
 * 切到「纯色喷漆」开关则去掉 baseColor 贴图，整车变纯色车漆。
 *
 * onChange(hex, { solid }) 每次选色实时回调；set(hex, solid) 供方案恢复同步（不回调）。
 */

/* ---------------------------- 颜色工具 ---------------------------- */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

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
      .map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0'))
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

function rgbStr(r, g, b) {
  return `rgb(${Math.round(clamp(r, 0, 1) * 255)}, ${Math.round(clamp(g, 0, 1) * 255)}, ${Math.round(clamp(b, 0, 1) * 255)})`;
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

export function createColorWheel({ value = '#ffffff', solid = false, onChange } = {}) {
  const SIZE = 264;
  const PAD = 11;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const maxR = SIZE / 2 - PAD - 7;

  /* 色轮画布：锥形色相 + 径向饱和度 */
  const canvas = el('canvas', { class: 'cw-wheel', width: String(SIZE), height: String(SIZE) });
  const ctx = canvas.getContext('2d');

  function drawWheel() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    const curRgb = rgbStr(...hsvToRgb(curH, curS, curV));

    // 金属斜切外圈
    const ring = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    ring.addColorStop(0, '#4a525e');
    ring.addColorStop(0.5, '#20252c');
    ring.addColorStop(1, '#4a525e');
    ctx.beginPath();
    ctx.arc(cx, cy, maxR + 7, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();

    // 当前色发光环
    ctx.beginPath();
    ctx.arc(cx, cy, maxR + 5, 0, Math.PI * 2);
    ctx.strokeStyle = curRgb;
    ctx.lineWidth = 2.4;
    ctx.shadowColor = curRgb;
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 内细亮环
    ctx.beginPath();
    ctx.arc(cx, cy, maxR + 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 锥形色相
    const hue = ctx.createConicGradient(0, cx, cy);
    for (let i = 0; i <= 360; i += 12) {
      const [r, g, b] = hsvToRgb(i, 1, 1);
      hue.addColorStop(i / 360, rgbStr(r, g, b));
    }
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.fillStyle = hue;
    ctx.fill();

    // 径向饱和度：中心白
    const sat = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    sat.addColorStop(0, 'rgba(255,255,255,1)');
    sat.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.fillStyle = sat;
    ctx.fill();

    // 暗角
    const vig = ctx.createRadialGradient(cx, cy, maxR * 0.5, cx, cy, maxR);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.fillStyle = vig;
    ctx.fill();

    // 中心枢轴
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0d10';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 玻璃高光（CSS 叠加层，pointer-events:none）
  const gloss = el('div', { class: 'cw-gloss' });
  const marker = el('div', { class: 'cw-marker' });
  const wheelWrap = el('div', { class: 'cw-wheel-wrap' }, canvas, gloss, marker);

  /* 顶部玻璃预览球 */
  const orb = el('div', { class: 'cw-orb' });
  const orbName = el('span', { class: 'cw-orb-name' }, '');

  /* 明度滑杆 */
  const bright = el('input', {
    type: 'range',
    class: 'cw-bright',
    min: '0',
    max: '100',
    step: '1',
    value: '100',
  });
  const brightTrack = el('div', { class: 'cw-bright-track' });
  const brightWrap = el('div', { class: 'cw-bright-wrap' }, brightTrack, bright);

  /* HEX 输入 */
  const hexInput = el('input', {
    type: 'text',
    class: 'cw-hex-input',
    value,
    maxlength: 7,
    spellcheck: false,
  });
  const hexChip = el('div', { class: 'cw-hex-chip' });
  const hexBox = el('div', { class: 'cw-hex-box' }, hexChip, hexInput);

  /* 预设色板（烤漆小方块） */
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
  const swatchEls = new Map();
  const swatches = el('div', { class: 'cw-swatches' });
  for (const [c, name] of PRESETS) {
    const sEl = el(
      'button',
      {
        class: 'cw-swatch',
        title: name,
        'aria-label': name,
        onclick: () => applyHex(c),
      },
      el('span', { class: 'cw-swatch-chip', style: `background:${c}` })
    );
    swatchEls.set(c, sEl);
    swatches.appendChild(sEl);
  }

  /* 纯色喷漆开关：iOS 风格 */
  const solidChk = el('input', { type: 'checkbox' });
  solidChk.checked = !!solid;
  solidChk.addEventListener('change', () => emit());
  const solidSwitch = el('span', { class: 'cw-switch-knob' });
  const solidTrack = el('label', { class: 'cw-switch' }, solidChk, solidSwitch);
  const solidRow = el(
    'div',
    { class: 'cw-solid-row' },
    el('div', { class: 'cw-solid-text' }, el('span', { class: 'cw-row-label' }, '纯色喷漆'), el('span', { class: 'cw-solid-hint' }, '覆盖原车贴图')),
    solidTrack
  );

  const resetBtn = el(
    'button',
    {
      class: 'btn ghost cw-reset',
      onclick: () => {
        solidChk.checked = false;
        applyHex('#ffffff');
      },
    },
    '还原原车色'
  );

  /* 状态 */
  let curH = 0,
    curS = 0,
    curV = 1;

  function currentColor() {
    return toHex(...hsvToRgb(curH, curS, curV));
  }

  function paintSphere(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [h, s, v] = rgbToHsv(r, g, b);
    const light = rgbStr(...hsvToRgb(h, Math.min(1, s * 0.7), Math.min(1, v * 1.18 + 0.05)));
    const dark = rgbStr(...hsvToRgb(h, Math.min(1, s + 0.05), Math.max(0.18, v * 0.5)));
    orb.style.background = `radial-gradient(circle at 33% 28%, ${light} 0%, ${hex} 42%, ${dark} 100%)`;
    orb.style.boxShadow = `0 8px 22px ${hex}55, inset 0 0 0 1px rgba(255,255,255,0.14)`;
    hexChip.style.background = hex;
  }

  function placeMarker() {
    const ang = (curH * Math.PI) / 180;
    const rad = curS * maxR;
    marker.style.left = `${cx + rad * Math.cos(ang)}px`;
    marker.style.top = `${cy + rad * Math.sin(ang)}px`;
  }

  function updateBrightnessGradient() {
    const [r, g, b] = hsvToRgb(curH, curS, 1);
    brightTrack.style.background = `linear-gradient(90deg, #0c0e11 0%, ${rgbStr(r, g, b)} 100%)`;
  }

  function setActiveSwatch(hex) {
    let name = '';
    for (const [c, btn] of swatchEls) {
      const on = c.toLowerCase() === hex.toLowerCase();
      btn.classList.toggle('active', on);
      if (on) name = btn.getAttribute('aria-label') || '';
    }
    orbName.textContent = name;
  }

  function emit() {
    const hex = currentColor();
    hexInput.value = hex;
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
    updateBrightnessGradient();
    paintSphere(hex);
    drawWheel();
    setActiveSwatch(hex);
    if (doEmit) emit();
  }

  function setFromWheel(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const dx = clientX - rect.left - cx;
    const dy = clientY - rect.top - cy;
    const r = Math.hypot(dx, dy);
    let h = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (h < 0) h += 360;
    const s = clamp(r / maxR, 0, 1);
    curH = h;
    curS = s;
    placeMarker();
    updateBrightnessGradient();
    paintSphere(currentColor());
    drawWheel();
    emit();
  }

  /* 事件 */
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    setFromWheel(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) setFromWheel(e.clientX, e.clientY);
  });
  bright.addEventListener('input', () => {
    curV = parseInt(bright.value, 10) / 100;
    paintSphere(currentColor());
    drawWheel();
    emit();
  });
  hexInput.addEventListener('change', () => {
    let v = hexInput.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) applyHex(v.toLowerCase());
    else hexInput.value = currentColor();
  });
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hexInput.blur();
  });

  // 初始色值（不回调）
  applyHex(value, false);

  const root = el(
    'div',
    { class: 'cw' },
    el(
      'div',
      { class: 'cw-header' },
      el('div', { class: 'cw-head-text' }, el('span', { class: 'cw-title' }, '车漆改色'), orbName),
      orb
    ),
    wheelWrap,
    el('div', { class: 'cw-bright-block' }, el('div', { class: 'cw-bright-row' }, el('span', { class: 'cw-row-label' }, '明度'), hexBox), brightWrap),
    el('div', { class: 'cw-section' }, el('span', { class: 'cw-row-label' }, '精选车漆'), swatches),
    solidRow,
    el('div', { class: 'cw-reset-row' }, resetBtn)
  );

  return {
    root,
    set(hex, s) {
      solidChk.checked = !!s;
      applyHex(hex, false);
    },
  };
}
