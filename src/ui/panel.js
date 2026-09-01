/**
 * panel.js — 控制面板（声明式构建）
 *
 * 交互原则（对应需求 4「全程自动」）：
 *   选完照片立刻开始生成，没有"确认"按钮；
 *   滑杆拖动即生效，不需要"应用"；
 *   模型生成完自动装载、自动摆正、自动切除原车轮、自动装配四个新轮。
 *
 * 需求 1：轮毂参数支持「4轮 / 前轴 / 后轴」三种作用域，
 *         选「4轮」时一次改两根轴，选单轴时只改那一根。
 */

import { ET_REF } from '../tuning/wheelRig.js';
import { RIM_PRESETS } from '../tuning/proceduralRim.js';
import { createColorWheel } from './colorWheel.js';
import {
  fenderStatus,
  groundClearanceStatus,
  deltaStatus,
  MIN_GROUND_CLEARANCE_MM as MIN_GC,
  GC_WARN_MM as GC_WARN,
  FENDER_MIN_MM as FENDER_MIN,
  FENDER_SAFE_MM as FENDER_SAFE,
  MAX_TOTAL_DELTA_MM as MAX_DELTA,
  DELTA_OK_MM as DELTA_OK,
} from '../tuning/suspension.js';

/* ---------------------------- DOM 小工具 ---------------------------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'value' && 'value' in node) node.value = v;
    else if (k === 'checked' && 'checked' in node) node.checked = !!v;
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

/* ---------------------------- 参数定义 ---------------------------- */

const PRESETS = {
  原厂: { et: 38, j: 8.5, camber: -0.5, rimInch: 18, tireWidthMm: 255, aspect: 40 },
  齐平Flush: { et: 32, j: 9.5, camber: -1.5, rimInch: 19, tireWidthMm: 265, aspect: 35 },
  宽体: { et: 20, j: 11, camber: -2.5, rimInch: 19, tireWidthMm: 295, aspect: 30 },
  HellaFlush: { et: 12, j: 10.5, camber: -4.5, rimInch: 19, tireWidthMm: 275, aspect: 30 },
};

/** 轮毂本体参数：每根轴一份，受作用域选择器控制 */
const AXLE_PARAMS = [
  { key: 'et', label: 'ET 偏距', unit: 'mm', min: 0, max: 60, step: 1, hint: '越小越外凸' },
  { key: 'j', label: 'J 值（轮辋宽度）', unit: 'J', min: 5, max: 13, step: 0.5, hint: '1J = 25.4mm' },
  { key: 'camber', label: '倾角', unit: '°', min: -6, max: 3, step: 0.25, hint: '负值 = 顶部内倾' },
  { key: 'rimInch', label: '轮辋直径', unit: 'in', min: 15, max: 24, step: 0.5, hint: '改尺寸时车高随之变化' },
  { key: 'tireWidthMm', label: '胎宽', unit: 'mm', min: 185, max: 355, step: 5, hint: '断面宽' },
  { key: 'aspect', label: '扁平比', unit: '%', min: 25, max: 60, step: 1, hint: '外径 = 轮辋 + 2×胎宽×扁平比' },
];

/** 车型识别数据：由 /api/specs 整理后落地，直接驱动 3D 比例 */
const VEHICLE_PARAMS = [
  { key: 'carLength', label: '车长', unit: 'm', min: 3.0, max: 6.5, step: 0.01, hint: '车型识别后自动填入，可手动校正', global: true },
  { key: 'carWidth', label: '车宽', unit: 'm', min: 1.4, max: 2.3, step: 0.01, hint: '不含后视镜', global: true },
  { key: 'carHeight', label: '车高', unit: 'm', min: 1.2, max: 2.3, step: 0.01, hint: '整车高度', global: true },
  { key: 'wheelbase', label: '轴距', unit: 'mm', min: 2000, max: 4200, step: 10, hint: '前后轴中心距', global: true },
  { key: 'trackFront', label: '前轮距', unit: 'mm', min: 1200, max: 2200, step: 5, hint: '前轮中心距', global: true },
  { key: 'trackRear', label: '后轮距', unit: 'mm', min: 1200, max: 2200, step: 5, hint: '后轮中心距', global: true },
  { key: 'groundClearance', label: '离地间隙', unit: 'mm', min: 80, max: 500, step: 5, hint: '底盘最低点离地高度', global: true },
  { key: 'approachAngle', label: '接近角', unit: '°', min: 5, max: 45, step: 0.5, hint: '前端通过角', readOnly: true, global: true },
  { key: 'departureAngle', label: '离去角', unit: '°', min: 5, max: 45, step: 0.5, hint: '后端通过角', readOnly: true, global: true },
  { key: 'suspensionDelta', label: '悬挂降低 Δ', unit: 'mm', min: -10, max: 75, step: 1, hint: 'Δ>0 降低车身；与车身升降叠加成最终偏移', global: true },
];

/** 装配精细修正（旧版相对偏移，保留给 flush/宽体微调） */
const FINE_PARAMS = [
  { keyF: 'trackF', keyR: 'trackR', label: '轮距微调', unit: 'mm', min: -60, max: 60, step: 1, hint: '正 = 整体外扩' },
  { keyF: 'axleF', keyR: 'axleR', label: '轴位置前后', unit: 'mm', min: -150, max: 150, step: 5, hint: '正 = 往车头方向移' },
];

/** 轮毂校准安全网：对 AI 生成的轮毂做手动微调（绕轮轴旋转 + 轮平面内/轴向小幅偏移） */
const RIM_CALIB_PARAMS = [
  { key: 'rimSpinDeg', label: '旋转', unit: '°', min: -180, max: 180, step: 1, hint: '绕轮轴旋转', global: true },
  { key: 'rimOffsetX', label: '横向', unit: 'mm', min: -30, max: 30, step: 1, hint: '轮平面内横向偏移', global: true },
  { key: 'rimOffsetY', label: '竖向', unit: 'mm', min: -30, max: 30, step: 1, hint: '轮平面内竖向偏移', global: true },
  { key: 'rimOffsetZ', label: '轴向', unit: 'mm', min: -30, max: 30, step: 1, hint: '沿轮轴 seating 微调', global: true },
];


const AXLE_OPTIONS = [
  ['all', '4 轮'],
  ['front', '前轴'],
  ['rear', '后轴'],
];

const SUSPENSION_OPTIONS = [
  ['all', '四轮'],
  ['front', '前轴'],
  ['rear', '后轴'],
  ['FL', '左前'],
  ['FR', '右前'],
  ['RL', '左后'],
  ['RR', '右后'],
];

/** 曝光滑杆范围（与场景预设无关，用户随时可覆盖） */
const EXPOSURE = { min: 0.3, max: 2.5, step: 0.01 };

/* ---------------------------- 上传区 ---------------------------- */

/**
 * 上传区控件。
 * @param {Object} o
 * @param {boolean=} o.recognition 是否启用视觉识别（车型识别 + 真车参数）。
 *   轮毂传 false：轮毂照片识别不出车型，跑视觉接口没有意义（用户要求取消）。
 */
function makeUploader({ title, hint, onFiles, recognition = true }) {
  const input = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (files.length) onFiles(files);
    input.value = '';
  });

  const thumbs = el('div', { class: 'thumbs' });
  const bar = el('div', { class: 'prog-bar' }, el('div', { class: 'prog-fill' }));
  const status = el('div', { class: 'upload-status' }, hint);
  // 失败后的恢复操作（继续等待 / 重试 / 换票后重试 / 改用演示模型）
  const actions = el('div', { class: 'upload-actions' });
  // 失败原因的展开细节（错误码、JobId 等），默认收起
  const detail = el('div', { class: 'upload-detail' });

  // 任务名称：整车由视觉模型识别后自动填入；轮毂不做识别，纯手动（选填）
  const nameInput = el('input', {
    type: 'text',
    class: 'task-name',
    placeholder: recognition ? '上传后自动识别车型，可手动修改' : '可手动命名（选填）',
    maxlength: '40',
  });
  const nameWrap = el(
    'div',
    { class: 'task-name-wrap' },
    el('label', { class: 'task-name-label' }, '任务名称'),
    nameInput
  );
  // 识别状态提示（识别中 / 已识别 / 未配置识别模型）——轮毂不启用，不渲染
  const recog = el('div', { class: 'recog-hint' }, '');

  const zone = el(
    'div',
    { class: 'dropzone' },
    el('div', { class: 'dz-title' }, title),
    el('div', { class: 'dz-sub' }, '点击选择，或把照片拖到这里'),
    input,
    thumbs,
    bar,
    status,
    actions,
    detail,
    nameWrap,
    // 关掉识别的上传区（轮毂）不渲染识别行，避免留一行永远为空的提示
    ...(recognition ? [recog] : [])
  );

  zone.addEventListener('click', (e) => {
    // 恢复按钮区、细节区不触发"重新选图"
    if (e.target === input) return;
    if (actions.contains(e.target) || detail.contains(e.target)) return;
    input.click();
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('over');
    })
  );
  zone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) onFiles(files);
  });

  return {
    zone,
    setStatus(text, tone = '') {
      status.textContent = text;
      status.className = `upload-status ${tone}`;
    },
    setProgress(p) {
      bar.style.display = p > 0 && p < 1 ? 'block' : 'none';
      bar.firstChild.style.width = `${Math.round(p * 100)}%`;
    },
    setThumbs(files) {
      thumbs.innerHTML = '';
      for (const f of files) {
        const url = URL.createObjectURL(f);
        thumbs.appendChild(el('img', { src: url, class: 'thumb', title: f.name }));
      }
    },
    /** 取当前任务名称（trim 后） */
    getTaskName() {
      return (nameInput.value || '').trim();
    },
    /** 设置任务名称（识别成功后回填） */
    setTaskName(v) {
      nameInput.value = v || '';
    },
    /** 设置识别提示行；tone: ''|'ok'|'warn'|'err' */
    setRecog(text, tone = '') {
      recog.textContent = text || '';
      recog.className = `recog-hint ${tone}`;
    },

    /**
     * 渲染失败后的恢复动作。
     * @param {Array<{label:string, onClick:Function, tone?:'primary'|'ghost'}>} list 传空数组即清空
     */
    setActions(list = []) {
      actions.innerHTML = '';
      for (const a of list) {
        actions.appendChild(
          el(
            'button',
            {
              class: `btn small ${a.tone === 'primary' ? 'primary' : 'ghost'}`,
              onclick: (e) => {
                e.stopPropagation();
                a.onClick();
              },
            },
            a.label
          )
        );
      }
    },

    /** 多行说明 / 错误细节；传空字符串即清空 */
    setDetail(lines = '') {
      detail.innerHTML = '';
      if (!lines) return;
      for (const line of (Array.isArray(lines) ? lines : [lines]).filter(Boolean)) {
        detail.appendChild(el('div', { class: 'ud-line' }, line));
      }
    },

    /** 一次性把上一轮的失败痕迹清干净（重新开始生成时调用） */
    clearRecovery() {
      actions.innerHTML = '';
      detail.innerHTML = '';
    },
  };
}

/* ---------------------------- 面板装配 ---------------------------- */

export function createPanel(app, mount) {
  const sliders = [];

  /** 未识别到真车参数时的估算默认值 */
  function fallbackValue(key) {
    const L = app.params.carLength || 4.6;
    const W = app.params.carWidth || L * 0.45;
    switch (key) {
      case 'carWidth': return L * 0.45;
      case 'carHeight': return L * 0.32;
      case 'wheelbase': return L * 1000 * 0.5645;
      case 'trackFront': return W * 1000 * 0.859;
      case 'trackRear': return W * 1000 * 0.852;
      case 'groundClearance': return L * 1000 * 0.0272;
      case 'approachAngle': return 15;
      case 'departureAngle': return 15;
      default: return 0;
    }
  }

  /** 按当前作用域读一个参数（null 时返回估算默认值） */
  function readVal(spec) {
    const t = app.params.axleTarget;
    let v;
    if (spec.global) v = app.params[spec.key];
    else if (spec.keyF) v = t === 'rear' ? app.params[spec.keyR] : app.params[spec.keyF];
    else v = t === 'rear' ? app.params.rear[spec.key] : app.params.front[spec.key];
    if (v == null && spec.global) return fallbackValue(spec.key);
    return v;
  }

  /** 按当前作用域写一个参数 */
  function writeVal(spec, v) {
    const t = app.params.axleTarget;
    if (spec.global) {
      app.params[spec.key] = v;
    } else if (spec.keyF) {
      if (t !== 'rear') app.params[spec.keyF] = v;
      if (t !== 'front') app.params[spec.keyR] = v;
    } else {
      if (t !== 'rear') app.params.front[spec.key] = v;
      if (t !== 'front') app.params.rear[spec.key] = v;
    }
  }

  function decimals(spec) {
    return spec.step < 1 ? String(spec.step).split('.')[1]?.length || 1 : 0;
  }

  function makeSlider(spec, onChange) {
    const valueLabel = el('span', { class: 'ctl-value' });
    const input = spec.readOnly
      ? null
      : el('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, id: spec.key, name: spec.key });

    const render = () => {
      const d = decimals(spec);
      const t = app.params.axleTarget;
      const val = readVal(spec);
      if (input) input.value = val;

      let txt;
      if (spec.global) {
        txt = `${Number(val).toFixed(d)} ${spec.unit}`;
      } else if (t === 'all') {
        const fv = spec.keyF ? app.params[spec.keyF] : app.params.front[spec.key];
        const rv = spec.keyF ? app.params[spec.keyR] : app.params.rear[spec.key];
        txt =
          Math.abs(fv - rv) > 1e-9
            ? `前${fv.toFixed(d)} / 后${rv.toFixed(d)} ${spec.unit}`
            : `${fv.toFixed(d)} ${spec.unit}`;
      } else {
        txt = `${Number(val).toFixed(d)} ${spec.unit}`;
      }
      valueLabel.textContent = txt;
    };

    if (input) {
      input.addEventListener('input', () => {
        writeVal(spec, parseFloat(input.value));
        onChange?.();
        render();
      });
    }

    render();
    sliders.push({ render });

    const children = [
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, spec.label), valueLabel),
    ];
    if (input) children.push(input);
    if (spec.hint) children.push(el('div', { class: 'ctl-hint' }, spec.hint));
    return el('div', { class: 'ctl' }, ...children);
  }

  function makeSwitch(label, get, set) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!get();
    input.addEventListener('change', () => set(input.checked));
    return el('label', { class: 'switch' }, input, el('span', {}, label));
  }

  /* ---- 作用域选择器 ---- */
  const segButtons = AXLE_OPTIONS.map(([val, label]) =>
    el('button', {
      class: 'seg-btn',
      'data-axle': val,
      onclick: () => {
        app.params.axleTarget = val;
        syncSeg();
        syncAll();
      },
    }, label)
  );
  const segBar = el('div', { class: 'seg' }, ...segButtons);
  function syncSeg() {
    for (const b of segButtons)
      b.classList.toggle('on', b.dataset.axle === app.params.axleTarget);
  }

  /* ---- 步骤 1 / 2 ---- */
  const carUpload = makeUploader({
    title: '① 上传整车照片',
    hint: '建议 3–5 张：正前 45°、侧面、正后 45°、正前、正尾',
    onFiles: (files) => app.generateCar(files),
  });
  const wheelUpload = makeUploader({
    title: '② 上传轮毂照片',
    hint: '建议 3–5 张：只有轮毂的特写（正面 / 侧面 / 斜 45°），画面里不要带车身；生成后自动装配 4 只',
    // 轮毂不做视觉识别：识别不出车型，纯浪费一次接口调用与时间
    recognition: false,
    onFiles: (files) => app.generateWheel(files),
  });

  /* ---- 轮毂生成引擎：默认 Hyper3D Rodin ----
   * 与整车的引擎下拉框分开：轮毂必须走 Hyper3D，轮辋/辐条/螺栓孔位才准，
   * 不受全局引擎（默认 fal）影响。 */
  const WHEEL_ENGINE_OPTS = [
    ['hyper3d', 'Hyper3D Rodin — 轮毂默认'],
    ['hunyuan', '腾讯混元 — 免费，每天 5 次'],
  ];
  const wheelEngineSelect = el(
    'select',
    {
      class: 'cw-select',
      onchange: (e) => {
        app.params.wheelEngine = e.target.value;
      },
    },
    ...WHEEL_ENGINE_OPTS.map(([v, label]) => el('option', { value: v }, label))
  );
  wheelEngineSelect.value = app.params.wheelEngine || 'hyper3d';

  /* ---- 轮毂精度档位选择器（standard / high / extreme）---- */
  const PRECISION_OPTIONS = [
    ['standard', '标准'],
    ['high', '高精'],
    ['extreme', '极限'],
  ];
  const precButtons = PRECISION_OPTIONS.map(([val, label]) =>
    el('button', {
      class: 'chip',
      'data-prec': val,
      onclick: () => {
        app.params.precision = val;
        syncPrec();
      },
    }, label)
  );
  const precBar = el('div', { class: 'prec-bar' }, ...precButtons);
  const precHint = el(
    'div',
    { class: 'ctl-hint' },
    '生成精度：极限档细节最高，但可能更慢、偶发失败可重试'
  );
  wheelUpload.zone.appendChild(precBar);
  wheelUpload.zone.appendChild(precHint);
  function syncPrec() {
    for (const b of precButtons) b.classList.toggle('on', b.dataset.prec === app.params.precision);
  }
  syncPrec();

  /* ---- 轮毂款式：底部选择栏（不再放在上传生成区内） ----
   * 所有预设均指向真实 GLB 模型；加载失败时内部会自动回退到程序化轮毂。 */
  const rimPresetButtons = RIM_PRESETS.map((p) =>
    el('button', {
      class: 'chip',
      'data-rim-preset': p.id,
      onclick: () => app.loadPresetWheel(p.style),
    }, p.label)
  );
  function syncRimPreset() {
    for (const b of rimPresetButtons) b.classList.toggle('on', b.dataset.rimPreset === app.params.rimPreset);
  }

  /* ---- 步骤 3：轮毂参数 ---- */
  const presetBar = el('div', { class: 'presets' });
  for (const name of Object.keys(PRESETS)) {
    presetBar.appendChild(
      el('button', {
        class: 'chip',
        onclick: () => {
          const t = app.params.axleTarget;
          const src = PRESETS[name];
          if (t !== 'rear') Object.assign(app.params.front, src);
          if (t !== 'front') Object.assign(app.params.rear, src);
          syncAll();
          app.apply();
        },
      }, name)
    );
  }

  const readout = el('div', { class: 'readout' });
  const paramBox = el(
    'div',
    {},
    segBar,
    presetBar,
    ...AXLE_PARAMS.map((spec) => makeSlider(spec, () => app.apply())),
    readout
  );

  /* ---- 悬挂读数（3 行着色，依赖 chassis.suspensionReadout）---- */
  const suspReadout = el('div', { class: 'readout susp' });
  const suspNote = el(
    'div',
    { class: 'susp-note' },
    '悬挂调节只移动车身，轮胎始终贴地；下方分角悬挂可与全局 Δ 叠加'
  );

  /* ---- 车型数据（由识别结果整理，直接驱动比例） ---- */
  const vehicleBox = el(
    'div',
    { class: 'fine' },
    ...VEHICLE_PARAMS.map((spec) =>
      makeSlider(spec, () => {
        if (spec.key === 'suspensionDelta') app.apply();
        else app.rescaleCar(app.params.carLength);
      })
    ),
    suspNote,
    suspReadout,
    el(
      'div',
      { class: 'switches' },
      makeSwitch('显示轮胎', () => app.params.showTire, (v) => {
        app.params.showTire = v;
        app.apply();
      }),
      makeSwitch('车轮随动旋转', () => app.params.spin, (v) => {
        app.params.spin = v;
      }),
      makeSwitch('相机自动环绕', () => app.params.autoRotate, (v) => {
        app.viewer.controls.autoRotate = v;
      })
    ),
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn ghost', onclick: () => app.reset() }, '重置参数')
    )
  );

  /* ---- 悬挂高度（分角/分轴/四轮同时调节） ---- */
  const suspValueLabel = el('span', { class: 'ctl-value' });
  const suspInput = el('input', { type: 'range', min: -120, max: 120, step: 1, id: 'suspensionHeight', name: 'suspensionHeight' });
  const suspReadoutCorners = el('div', { class: 'susp-corners' });

  function avgSuspension(target) {
    const s = app.params.suspension;
    switch (target) {
      case 'all': return (s.FL + s.FR + s.RL + s.RR) / 4;
      case 'front': return (s.FL + s.FR) / 2;
      case 'rear': return (s.RL + s.RR) / 2;
      default: return s[target] || 0;
    }
  }
  function setSuspension(target, v) {
    const s = app.params.suspension;
    switch (target) {
      case 'all': s.FL = s.FR = s.RL = s.RR = v; break;
      case 'front': s.FL = s.FR = v; break;
      case 'rear': s.RL = s.RR = v; break;
      default: s[target] = v; break;
    }
  }
  function renderSuspensionReadout() {
    const s = app.params.suspension;
    const fmt = (n) => `${n > 0 ? '+' : ''}${n.toFixed(0)}`;
    suspReadoutCorners.innerHTML = '';
    const items = [
      ['FL', '左前'], ['FR', '右前'], ['RL', '左后'], ['RR', '右后'],
    ];
    for (const [id, label] of items) {
      const active = app.params.suspensionTarget === 'all' || app.params.suspensionTarget === id ||
        (app.params.suspensionTarget === 'front' && id.startsWith('F')) ||
        (app.params.suspensionTarget === 'rear' && id.startsWith('R'));
      suspReadoutCorners.appendChild(
        el('span', { class: `susp-corner ${active ? 'active' : ''}` }, `${label} ${fmt(s[id])}`)
      );
    }
  }
  function renderSuspension() {
    const v = avgSuspension(app.params.suspensionTarget);
    suspInput.value = v;
    suspValueLabel.textContent = `${v > 0 ? '+' : ''}${v.toFixed(0)} mm`;
    renderSuspensionReadout();
  }
  suspInput.addEventListener('input', () => {
    setSuspension(app.params.suspensionTarget, parseFloat(suspInput.value));
    app.apply();
    renderSuspension();
  });

  const suspTargetButtons = SUSPENSION_OPTIONS.map(([val, label]) =>
    el('button', {
      class: 'seg-btn small',
      'data-susp': val,
      onclick: () => {
        app.params.suspensionTarget = val;
        syncSuspTarget();
        renderSuspension();
      },
    }, label)
  );
  const suspTargetBar = el('div', { class: 'seg susp-seg' }, ...suspTargetButtons);
  function syncSuspTarget() {
    for (const b of suspTargetButtons) b.classList.toggle('on', b.dataset.susp === app.params.suspensionTarget);
  }

  const suspensionBox = el(
    'div',
    { class: 'fine' },
    suspTargetBar,
    el('div', { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, '悬挂高度偏移'), suspValueLabel),
      suspInput,
      el('div', { class: 'ctl-hint' }, '正值 = 该角/轴车身升高；四轮同步即整车升降')
    ),
    suspReadoutCorners,
    el('div', { class: 'ctl-hint' }, '正值 = 该角/轴车身相对地面升高；前后差会产生俯仰，左右差会产生侧倾')
  );

  /* ---- 装配精细修正（相对偏移，可选） ---- */
  const fineBox = el(
    'div',
    { class: 'fine fine-secondary' },
    ...FINE_PARAMS.map((spec) => makeSlider(spec, () => app.apply()))
  );

  /* ---- 场景与灯光 ---- */

  const SCENE_OPTIONS = app.viewer.listPresets(); // [{ id, label, hint }]
  const sceneButtons = SCENE_OPTIONS.map((p) =>
    el('button', {
      class: 'seg-btn',
      'data-scene': p.id,
      title: p.hint || p.label,
      onclick: () => app.setEnvironment(p.id),
    }, p.label)
  );
  const sceneBar = el('div', { class: 'seg six' }, ...sceneButtons);
  const sceneHint = el('div', { class: 'ctl-hint' }, '');

  function syncScene() {
    const cur = app.params.envId;
    for (const b of sceneButtons) b.classList.toggle('on', b.dataset.scene === cur);
    const p = SCENE_OPTIONS.find((x) => x.id === cur);
    sceneHint.textContent = p?.hint || '';
  }

  const sceneBox = el('div', {}, sceneBar, sceneHint);

  // 灯光行：切场景后光源数量/种类都会变，整块重建
  const lightList = el('div', { class: 'light-list' });
  const lightRows = [];

  function rebuildLights() {
    lightList.innerHTML = '';
    lightRows.length = 0;

    for (const L of app.viewer.getLights()) {
      const valueLabel = el('span', { class: 'ctl-value' });
      const range = el('input', {
        type: 'range',
        min: L.min,
        max: L.max,
        step: L.step,
        value: L.intensity,
      });
      const chk = el('input', { type: 'checkbox' });
      const row = el('div', { class: 'light-row' });

      const sync = () => {
        const cur = app.viewer.getLights().find((x) => x.id === L.id);
        const on = cur ? cur.enabled : L.enabled;
        const iv = cur ? cur.intensity : L.intensity;
        chk.checked = on;
        range.value = iv;
        valueLabel.textContent = Number(iv).toFixed(2);
        row.classList.toggle('off', !on);
      };

      chk.addEventListener('change', () => {
        app.setLightEnabled(L.id, chk.checked);
        sync();
      });
      range.addEventListener('input', () => {
        app.setLightIntensity(L.id, parseFloat(range.value));
        sync();
      });

      row.appendChild(
        el(
          'div',
          { class: 'light-head' },
          el('label', { class: 'switch' }, chk, el('span', {}, L.label)),
          el('span', { class: 'light-role' }, `${L.role}${L.castShadow ? ' · 投影' : ''}`),
          valueLabel
        )
      );
      row.appendChild(range);
      lightList.appendChild(row);
      lightRows.push(sync);
      sync();
    }
  }

  // 曝光
  const expoValue = el('span', { class: 'ctl-value' });
  const expoInput = el('input', {
    type: 'range',
    min: EXPOSURE.min,
    max: EXPOSURE.max,
    step: EXPOSURE.step,
  });
  function syncExposure() {
    const v = app.viewer.getExposure();
    expoInput.value = v;
    expoValue.textContent = Number(v).toFixed(2);
  }
  expoInput.addEventListener('input', () => {
    app.setExposure(parseFloat(expoInput.value));
    syncExposure();
  });

  const lightBox = el(
    'div',
    {},
    lightList,
    el(
      'div',
      { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, '曝光'), expoValue),
      expoInput,
      el('div', { class: 'ctl-hint' }, '整体明暗；切换场景会回到该场景的出厂曝光')
    ),
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn ghost',
        onclick: () => {
          app.resetLights();
          syncExposure();
          for (const s of lightRows) s();
        },
      }, '恢复本场景默认灯光')
    )
  );

  /* ---- 视角 ---- */
  const views = el(
    'div',
    { class: 'views' },
    ...[
      ['45°', 'iso'],
      ['正侧', 'side'],
      ['正前', 'front'],
      ['正后', 'rear'],
      ['俯视', 'top'],
      ['轮毂特写', 'wheel'],
    ].map(([label, key]) =>
      el('button', { class: 'btn small', onclick: () => app.setView(key) }, label)
    )
  );

  // 凭证状态卡：四态（LIVE / 临近过期 / 已失效 / DEMO），带换票指引与「我已更新」
  const modeBadge = el('div', { class: 'mode-badge' }, '');

  /* ---- 车漆：HSV 色轮（见 colorWheel.js），改色只动车身材质 ---- */
  const colorWheel = createColorWheel({
    value: app.params.bodyColor,
    solid: app.params.bodySolid,
    onChange: (hex, { solid }) => {
      app.params.bodyColor = hex;
      app.params.bodySolid = !!solid;
      app.setBodyColor(hex, !!solid);
    },
  });

  /* ---- 顶层功能分层级：整车 / 轮毂 / 车漆 / 场景 ----
   * 注意：BANG 拆解**不在这里**。拆解是生成流水线里的自动环节
   *（见 server/index.mjs runHyper3D 的自动 BANG 阶段），
   * 用户在 Hyper3D 生成完成后直接拿到已拆好的部件，不需要自己触发。 */
  const TABS = [
    ['body', '整车'],
    ['wheels', '轮毂'],
    ['paint', '车漆'],
    ['scene', '场景'],
  ];
  const tabBodies = {};
  const tabButtons = {};
  const tabsBar = el('div', { class: 'tabs' });
  for (const [id, label] of TABS) {
    const btn = el('button', { class: 'tab', 'data-tab': id, onclick: () => setTab(id) }, label);
    tabButtons[id] = btn;
    tabsBar.appendChild(btn);
    tabBodies[id] = el('div', { class: 'tab-body' });
  }
  function setTab(id) {
    for (const k of Object.keys(tabBodies)) {
      tabBodies[k].classList.toggle('hidden', k !== id);
      tabButtons[k].classList.toggle('active', k === id);
    }
    bottomPresetBar.classList.toggle('hidden', id !== 'wheels');
  }

  // 轮毂校准安全网（摆位微调）
  const rimCalibBox = el(
    'div',
    { class: 'fine' },
    ...RIM_CALIB_PARAMS.map((spec) => makeSlider(spec, () => app.apply())),
    el(
      'div',
      { class: 'ctl-hint' },
      '旋转：绕轮轴转动；横/竖向：轮平面内微调；轴向：沿轮轴 seating 微调'
    )
  );

  /* ---- 生成引擎：精度 / 成本由用户选择 ----
   * 引擎优先级（自动回退）见 main.js ENGINE_PRIORITY；这里给手动覆盖的入口。 */
  const ENGINE_OPTS = [
    ['hyper3d', 'Hyper3D Rodin — 车模生成专用'],
    ['hunyuan', '腾讯混元 — 免费，每天 5 次'],
    ['higen3d', 'HiGen3D — 待配置'],
  ];
  const engineSelect = el(
    'select',
    {
      class: 'cw-select',
      onchange: (e) => {
        app.params.engine = e.target.value;
        // 立刻重查后端凭证状态，让状态卡反映新引擎能不能跑 LIVE
        app.refreshHealth?.();
      },
    },
    ...ENGINE_OPTS.map(([v, label]) => el('option', { value: v }, label))
  );
  engineSelect.value = app.params.engine;
  tabBodies.body.appendChild(
    section(
      '生成引擎',
      el(
        'div',
        { class: 'fine' },
        el('div', { class: 'ctl' }, engineSelect),
        el(
          'div',
          { class: 'ctl-hint' },
          '没配凭证的引擎会自动跳过，回退到有凭证的那个；具体状态看下方状态卡。'
        )
      )
    )
  );

  /* ---- 拆解部件视图（Hyper3D BANG） ----
   * 生成流水线会自动 BANG 拆解，产物按**原坐标装配回整车原位**，
   * 所以这里看到的仍是"一辆完整的车"，只是它由可拆部件组成。
   * 给两个视图切换 + 爆炸滑杆，用来核对拆出来的部件。 */
  const bangStatus = el('div', { class: 'ctl-hint' }, '尚未拆解');
  const bangExplodeVal = el('span', { class: 'ctl-value' }, '0%');
  const bangExplode = el('input', {
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    value: Math.round((app.params.bangExplode || 0) * 100),
    oninput: (e) => {
      const pct = Number(e.target.value);
      bangExplodeVal.textContent = `${pct}%`;
      app.setBangExplode(pct / 100);
    },
  });
  function syncBang() {
    const info = app.bangInfo();
    if (!info.total) {
      bangStatus.textContent = app.params.carModelUrl
        ? '这台车还没有拆解产物：点下方「重新拆解」拿实体车身（未拆解的整车是空壳，轮拱是画在贴图上的）'
        : '尚未拆解（生成整车时会自动拆解，不需要手动操作）';
      return;
    }
    const g = info.geom;
    bangStatus.textContent =
      `已装配 ${info.body} 个车身部件（只放拆开的车身，车轮不进场景）· 当前${
        info.view === 'single' ? '整车单体' : '拆解装配'
      }视图` +
      (g
        ? ` · 轮位按拆解实测：轴距 ${g.wheelbase} / 前 ${g.trackFront} / 后 ${g.trackRear} mm`
        : '');
  }
  const bangBox = el(
    'div',
    { class: 'fine' },
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn small', onclick: () => { app.setBangView('assembled'); syncBang(); } }, '拆解装配视图'),
      el('button', { class: 'btn small', onclick: () => { app.setBangView('single'); syncBang(); } }, '整车单体视图')
    ),
    el(
      'div',
      { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, '爆炸视图'), bangExplodeVal),
      bangExplode
    ),
    el(
      'div',
      { class: 'btn-row' },
      el(
        'button',
        {
          class: 'btn ghost',
          onclick: async () => {
            bangStatus.textContent = '正在提交拆解…';
            const r = await app.bangCurrentCar();
            syncBang();
            if (!r) bangStatus.textContent = '拆解失败（详见提示）';
          },
        },
        '重新拆解（消耗 1 次额度）'
      ),
      el('button', { class: 'btn ghost', onclick: () => { app.clearBang(); syncBang(); } }, '清除拆解产物')
    ),
    bangStatus,
    el(
      'div',
      { class: 'ctl-hint' },
      'Hyper3D 生成完成后会自动拆解：只把拆开的**车身**按原坐标装回原位（车轮不入场景），所以不会是两辆车、也不会少件。拆出来的四个车轮用来反推真实轴距/轮距，生成的轮毂因此精确落在原车轮位置上，不会偏离轮拱造成穿模。拖爆炸滑杆可把车身部件散开核对。'
    )
  );

  /* 车身朝向调正：Hyper3D 生成的车头朝向随机（左右可能颠倒），
   * 点按钮兜底一键转 90°/180°，会重新归一 + 重算轮位。 */
  const orientBox = el(
    'div',
    { class: 'fine' },
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn small', onclick: () => app.rotateCar(1) }, '↺ 左转 90°'),
      el('button', { class: 'btn small', onclick: () => app.rotateCar(-1) }, '↻ 右转 90°'),
      el('button', { class: 'btn small', onclick: () => app.rotateCar(2) }, '⇋ 翻转 180°')
    ),
    el(
      'div',
      { class: 'ctl-hint' },
      'Hyper3D 生成的车头朝向随机（左右可能颠倒），如果你的车看起来前后反了或侧面反了，点对应按钮一键旋转。每次点都会重新归一并按新朝向重算轮位。'
    )
  );

  tabBodies.body.appendChild(section('整车模型', carUpload.zone));
  tabBodies.body.appendChild(section('车身朝向', orientBox));
  tabBodies.body.appendChild(section('拆解部件（Hyper3D BANG）', bangBox));
  tabBodies.body.appendChild(section('车型数据', vehicleBox));
  tabBodies.body.appendChild(section('悬挂高度（分轴/分角）', suspensionBox));
  tabBodies.body.appendChild(collapsible('精细修正（相对偏移）', fineBox));
  tabBodies.wheels.appendChild(section('轮毂模型', wheelUpload.zone));
  tabBodies.wheels.appendChild(
    section(
      '轮毂生成引擎',
      el(
        'div',
        { class: 'fine' },
        el('div', { class: 'ctl' }, wheelEngineSelect),
        el(
          'div',
          { class: 'ctl-hint' },
          '轮毂固定走 Hyper3D Rodin（与整车同一家，按订阅额度计费），不受整车引擎下拉框影响；轮毂不做自动拆解，省一次额度。'
        )
      )
    )
  );
  tabBodies.wheels.appendChild(section('轮毂校准（生成模型摆位不正时微调）', rimCalibBox));
  tabBodies.wheels.appendChild(section('轮毂参数', paramBox));

  /* ---- 切除原车轮：换轮毂前必须的一步 ----
   * AI 生成的车车轮是焊死在车身里的（实测为单连通块），不切掉的话
   * 新轮毂会和原车轮重叠。按四轮位置做圆柱区域剔除。 */
  const cutStatus = el('div', { class: 'ctl-hint' }, '未切除');
  const cutBtn = el('button', { class: 'btn primary' }, '切除原车轮');
  const restoreBtn = el('button', { class: 'btn ghost' }, '恢复原车轮');

  /* 切除余量做成可调：不同车型轮子大小不一。
   * 默认值来自实测——演示车上最近的车轮几何在径向 0.369 / 轴向 0.158，
   * 而 rig 估算的轮胎半径 0.33、半宽 0.1275，必须放大才罩得住。 */
  const cutR = { v: 1.15 };
  const cutW = { v: 0.04 };
  const mkCutSlider = (label, store, min, max, step, fmt) => {
    const val = el('span', { class: 'ctl-value' }, fmt(store.v));
    return el(
      'div',
      { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, label), val),
      el('input', {
        type: 'range',
        min,
        max,
        step,
        value: store.v,
        oninput: (e) => {
          store.v = Number(e.target.value);
          val.textContent = fmt(store.v);
        },
      })
    );
  };

  cutBtn.onclick = () => {
    const r = app.cutOriginalWheels({ radiusScale: cutR.v, widthPad: cutW.v });
    if (!r || !r.cylinders) {
      cutStatus.textContent = '切除失败：未找到轮位（请先载入整车）';
      return;
    }
    cutStatus.textContent = r.removed
      ? `已切除 ${r.removed.toLocaleString()} 个三角面（${r.meshes} 个网格 / ${r.cylinders} 个轮位）`
      : '未切到任何面：试试调大切除半径';
  };
  restoreBtn.onclick = () => {
    const r = app.restoreOriginalWheels();
    cutStatus.textContent = r?.restored ? `已还原 ${r.restored} 个网格` : '没有可还原的内容';
  };

  const cutBox = el(
    'div',
    { class: 'fine' },
    mkCutSlider('半径放大', cutR, 1.0, 1.6, 0.01, (v) => `${v.toFixed(2)}×`),
    // 上限放到 300mm：rig 是按车身尺寸**估算**轮位的，实际轮子可能窄 100~200mm，
    // 必须允许把轴向余量拉大才切得干净（演示车实测偏差约 170mm）
    mkCutSlider('轴向余量', cutW, 0, 0.3, 0.005, (v) => `${(v * 1000).toFixed(0)}mm`),
    el('div', { class: 'btn-row' }, cutBtn, restoreBtn),
    cutStatus,
    el(
      'div',
      { class: 'ctl-hint' },
      '按四个轮位把原车轮从车身网格里剔除，新轮毂才能装进轮拱。切多了会伤到轮眉、切少了会有残留，用上面两个滑杆微调。可随时「恢复原车轮」。'
    )
  );
  tabBodies.wheels.appendChild(section('切除原车轮（换轮毂用）', cutBox));

  tabBodies.paint.appendChild(section('车漆', colorWheel.root));

  /* ---- 导入已拆解的部件（BANG 产物） ----
   * BANG 走 API 要 $120/月订阅，走网页版按次付费约 $0.75/台。
   * 所以用户在 Hyper3D 网页版 / Scenario 拆完，把 GLB 拖回这里，
   * 由本项目自动识别车轮并装到四轮 rig 上。 */
  const partInput = el('input', {
    type: 'file',
    accept: '.glb',
    multiple: true,
    class: 'part-file',
    style: 'display:none',
    onchange: async (e) => {
      const files = e.target.files;
      if (!files || !files.length) return;
      const r = await app.importBangParts(files);
      if (r?.total) {
        const wheelTxt = r.wheel
          ? `已识别车轮并装配 4 只（直径 ${(r.wheel.diameter * 1000).toFixed(0)}mm / 宽 ${(r.wheel.width * 1000).toFixed(0)}mm）`
          : '未识别到车轮（其余部件已摆在车旁）';
        wheelUpload.setStatus(`导入 ${r.total} 个部件：${wheelTxt}`, r.wheel ? 'ok' : 'warn');
      }
      e.target.value = ''; // 允许重复选同一批文件
    },
  });
  const partBox = el(
    'div',
    { class: 'fine' },
    el('div', { class: 'btn-row' }, el('button', { class: 'btn primary', onclick: () => partInput.click() }, '导入已拆部件（GLB）')),
    partInput,
    el(
      'div',
      { class: 'ctl-hint' },
      '在 Hyper3D 网页版 / Scenario 用 BANG 拆完部件后，把拆出的 GLB 选进来；会自动识别车轮并装到四个轮位，其余部件摆在车旁。'
    )
  );
  tabBodies.wheels.appendChild(section('导入已拆解部件（BANG）', partBox));

  tabBodies.scene.appendChild(section('场景', sceneBox));
  tabBodies.scene.appendChild(collapsibleOpen('灯光', lightBox));
  tabBodies.scene.appendChild(section('视角', views));

  /* ---- 底部轮毂款式选择栏：只在「轮毂」Tab 显示 ---- */
  const bottomPresetBar = el(
    'div',
    { class: 'bottom-preset-bar' },
    el('div', { class: 'bpb-label' }, '轮毂款式'),
    el('div', { class: 'bpb-chips' }, ...rimPresetButtons)
  );

  mount.appendChild(
    el(
      'div',
      { class: 'panel' },
      el(
        'header',
        { class: 'panel-head' },
        el('h1', {}, 'TUNING STUDIO'),
        el('p', { class: 'sub' }, '照片 → Hyper3D Rodin → GLB → 四轮实时装配')
      ),
      modeBadge,
      tabsBar,
      // 由 TABS 派生而不是逐个手写：新增 Tab 时不会漏挂对应的 body
      // （曾经因为手写列表漏挂，导致点了 Tab 所有面板都隐藏）
      ...TABS.map(([id]) => tabBodies[id]),
      bottomPresetBar
    )
  );

  setTab('body');

  syncSeg();
  syncScene();
  syncExposure();
  rebuildLights();

  /* ---- 右上角车身数据面板：展示识别出的车型真实尺寸 ---- */
  const bodyDataEl = document.getElementById('body-data');
  function renderBodyData() {
    const rs = app.params.realSpecs;
    if (!bodyDataEl) return;
    if (!rs || !rs.length) {
      bodyDataEl.classList.add('hidden');
      return;
    }
    bodyDataEl.classList.remove('hidden');
    const mm = (v) => (v ? `${v} mm` : '—');
    const deg = (v) => (v != null ? `${v}°` : '—');
    bodyDataEl.querySelector('.body-data__name').textContent = rs.fullName || rs.query || '已识别车型';
    bodyDataEl.querySelector('.body-data__conf').textContent =
      rs.confidence ? `把握 ${Math.round(rs.confidence * 100)}%` : '';
    const rows = [
      ['车长', mm(rs.length)],
      ['车宽', mm(rs.width)],
      ['车高', mm(rs.height)],
      ['轴距', mm(rs.wheelbase)],
      ['前/后轮距', rs.trackFront || rs.trackRear ? `${rs.trackFront || '—'} / ${rs.trackRear || '—'}` : '—'],
      ['离地间隙', mm(rs.groundClearance)],
      ['接近/离去角', `${deg(rs.approachAngle)} / ${deg(rs.departureAngle)}`],
    ];
    bodyDataEl.querySelector('.body-data__grid').innerHTML = rows
      .map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`)
      .join('');
    bodyDataEl.querySelector('.body-data__src').textContent = `数据来源：${rs.source || '车型参数库'}`;
  }

  function syncAll() {
    syncSeg();
    syncSuspTarget();
    syncScene();
    syncPrec();
    syncRimPreset();
    syncExposure();
    syncBang();
    renderBodyData();
    for (const s of sliders) s.render();
    renderSuspension();
    for (const s of lightRows) s();
  }

  function updateReadout() {
    const r = app.rig.report(app.params);
    readout.innerHTML = '';

    const line = (tag, val, verdict) => {
      const tone = verdict.level === 'good' ? 'good' : verdict.level === 'warn' ? 'warn' : 'ok';
      return el(
        'div',
        { class: `fit ${tone}` },
        el('span', { class: 'fit-verdict' }, `${tag} ${verdict.text}`),
        el('span', { class: 'fit-num' }, `${val >= 0 ? '+' : ''}${val.toFixed(0)} mm`)
      );
    };

    if (r.same) {
      readout.appendChild(line('', r.flushMm, r.verdict));
    } else {
      readout.appendChild(line('前轴', r.front.flushMm, r.front.verdict));
      readout.appendChild(line('后轴', r.rear.flushMm, r.rear.verdict));
    }
    readout.appendChild(
      el(
        'div',
        { class: 'fit-detail' },
        `轮辋外缘距车身侧面；相对 ET${ET_REF}，前轴外移 ${r.front.etOffsetMm.toFixed(0)}mm、` +
          `后轴外移 ${r.rear.etOffsetMm.toFixed(0)}mm`
      )
    );

    /* ---- 悬挂读数：3 行，按阈值绿/黄/红着色 + tooltip ---- */
    suspReadout.innerHTML = '';
    const chassis = app.chassis;
    // 底盘尚未完成 derive（rideHeight 仍为 0）时，先显示「计算中…」并强制 neutral 色，
    // 避免 derive 完成前的那一帧误报 danger 红；derive 完成后 rideHeight>0 再显示真实数值 + 三色状态。
    if (!chassis.derived && chassis.p.rideHeight <= 0) {
      for (const label of ['离地间隙', '轮拱间隙', '降低量 Δ']) {
        suspReadout.appendChild(
          el(
            'div',
            { class: 'susp-row' },
            el('span', { class: 'susp-label' }, label),
            el('span', { class: 'susp-val' }, '计算中…')
          )
        );
      }
    } else {
      const sr = chassis.suspensionReadout();
    const suspRows = [
      {
        label: '离地间隙',
        val: sr.groundClearance,
        status: groundClearanceStatus(sr.groundClearance),
        tip:
          sr.groundClearance < MIN_GC
            ? '已低于 ADR 最低离地 100mm'
            : sr.groundClearance < GC_WARN
              ? '接近 ADR 最低离地 100mm'
              : '',
      },
      {
        label: '轮拱间隙',
        val: sr.fenderGap,
        status: fenderStatus(sr.fenderGap),
        tip:
          sr.fenderGap < 0
            ? '必蹭胎'
            : sr.fenderGap < FENDER_MIN
              ? '轮拱 <5mm，将蹭胎'
              : sr.fenderGap < FENDER_SAFE
                ? '轮拱间隙偏紧，注意蹭胎风险'
                : '',
      },
      {
        label: '降低量 Δ',
        val: sr.deltaMm,
        status: deltaStatus(sr.deltaMm),
        tip:
          Math.abs(sr.deltaMm) > MAX_DELTA
            ? '超出合规总高变化 50mm'
            : Math.abs(sr.deltaMm) > DELTA_OK
              ? '总高变化较大，建议四轮定位'
              : '',
      },
    ];
    for (const row of suspRows) {
      const cls =
        row.status === 'good' ? 'susp-good' : row.status === 'warn' ? 'susp-warn' : 'susp-danger';
      const valText = `${row.val >= 0 ? '+' : ''}${row.val.toFixed(0)} mm`;
      const lineEl = el(
        'div',
        { class: `susp-row ${cls}`, title: row.tip || '' },
        el('span', { class: 'susp-label' }, row.label),
        el('span', { class: 'susp-val' }, valText)
      );
      if (row.tip) lineEl.appendChild(el('span', { class: 'susp-tip' }, row.tip));
      suspReadout.appendChild(lineEl);
    }
    } // end else (chassis 已 derive)
  }

  return {
    syncAll,
    updateReadout,
    setMode,
    // 车漆色随方案恢复时同步色轮显示（不回调，避免重复上色）
    syncColor: () => colorWheel.set(app.params.bodyColor, app.params.bodySolid),
    // 拆解部件装配/清除后同步状态行与滑杆
    syncBang: () => {
      syncBang();
      bangExplode.value = Math.round((app.params.bangExplode || 0) * 100);
      bangExplodeVal.textContent = `${Math.round((app.params.bangExplode || 0) * 100)}%`;
    },
    // 引擎可能在 refreshHealth 里被自动回退，下拉框建好之后仍要能跟着改
    syncEngine: () => {
      engineSelect.value = app.params.engine;
    },
    // 切场景时光源数量会变，由 main.js 的 setEnvironment 回调触发重建
    rebuildLights() {
      rebuildLights();
      syncExposure();
    },
    syncScene,
    carUpload,
    wheelUpload,
  };

  /**
   * 渲染凭证状态卡。
   *
   * @param {Object} s
   * @param {'live'|'expiring'|'expired'|'demo'|'unknown'} s.state
   * @param {string=} s.expiresAt  ISO8601，凭证预计失效时刻
   * @param {boolean=} s.rejected  这张票被云端明确拒过（此时文件里写的有效期不可信）
   * @param {string=} s.note       额外一行说明（例如刚失败的原因）
   * @param {Function=} s.onRefresh 点「我已更新」时回调（重查 /api/health）
   */
  function setMode(s) {
    const {
      state = 'unknown',
      expiresAt = '',
      rejected = false,
      note = '',
      onRefresh,
      engine = 'hunyuan',
      engineMode = 'demo',
    } = s || {};

    const ENGINE = {
      hyper3d: { name: 'Hyper3D', tokenFile: 'hyper3d', env: 'HYPER3D_API_KEY' },
      higen3d: { name: 'HiGen3D', tokenFile: 'higen3d', env: 'HIGEN3D_API_KEY' },
      hunyuan: { name: '混元 3D', tokenFile: 'hunyuan3d', env: 'HUNYUAN3D_TOKEN' },
    }[engine] || { name: '混元 3D', tokenFile: 'hunyuan3d', env: 'HUNYUAN3D_TOKEN' };

    // 只有当前引擎真正 live 才显示 LIVE；否则即便别的引擎有 key 也按当前引擎状态提示
    const isLive = state === 'live' && engineMode === 'live';

    const TEXT = {
      live: {
        icon: '●',
        title: `LIVE — 已接${ENGINE.name}`,
        body: '上传照片会真实生成模型，每次成功生成消耗一次额度。',
      },
      expiring: {
        icon: '◐',
        title: `LIVE — ${ENGINE.name}凭证即将过期`,
        body: '现在还能生成，但建议先换一张新票，避免生成到一半失效。',
      },
      expired: {
        icon: '○',
        title: rejected ? '凭证被拒 — 无法真实生成' : `凭证已过期 — 无法真实生成`,
        body: '换票后点下面的「我已更新」即可恢复，不用重启服务。',
      },
      demo: {
        icon: '○',
        title: `DEMO — 未配置${ENGINE.name}凭证`,
        body: '上传照片只会返回预置的演示模型（不是你的车），不消耗额度。',
      },
      unknown: {
        icon: '？',
        title: '后端未连接',
        body: '本地服务没起来，先运行 npm run dev。',
      },
    }[state] || { icon: '？', title: '状态未知', body: '' };

    modeBadge.className = `mode-badge ${state}`;
    modeBadge.innerHTML = '';
    modeBadge.appendChild(
      el('div', { class: 'mb-title' }, el('span', { class: 'mb-dot' }, TEXT.icon), TEXT.title)
    );
    modeBadge.appendChild(el('div', { class: 'mb-body' }, TEXT.body));

    if (expiresAt) {
      // 被云端拒过时，文件里写的有效期已经不可信，不能再显示"还有 xx 小时"误导人
      modeBadge.appendChild(
        el(
          'div',
          { class: 'mb-meta' },
          rejected
            ? `文件写的有效期至 ${fmtExpiry(expiresAt, false)}，但云端已拒绝这张票`
            : `凭证有效期至 ${fmtExpiry(expiresAt)}`
        )
      );
    }
    if (note) {
      modeBadge.appendChild(el('div', { class: 'mb-note' }, note));
    }

    // 只有需要换票的两态才给指引 + 按钮，LIVE 正常时保持干净
    if (state === 'expired' || state === 'demo') {
      modeBadge.appendChild(
        el(
          'ol',
          { class: 'mb-steps' },
          el('li', {}, `在对话里说一句「刷新${ENGINE.name}凭证」拿新票`),
          el('li', {}, `新票会自动写进 ~/.workbuddy/tokens/${ENGINE.tokenFile}（或环境变量 ${ENGINE.env}）`),
          el('li', {}, '回到这里点「我已更新」')
        )
      );
    }
    if (onRefresh) {
      modeBadge.appendChild(
        el(
          'div',
          { class: 'mb-actions' },
          el(
            'button',
            {
              class: 'btn small primary',
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.textContent = '重新检查中…';
                try {
                  await onRefresh();
                } finally {
                  // setMode 会整块重绘，这里兜底恢复（状态没变时）
                  if (btn.isConnected) {
                    btn.disabled = false;
                    btn.textContent = '我已更新';
                  }
                }
              },
            },
            '我已更新'
          )
        )
      );
    }
  }
}

/**
 * 把 ISO 时间转成「8月30日 20:47（还有 15 小时）」这种人话。
 * @param {boolean} withRemain 是否附带"还有多久"，票已被拒时要关掉，避免自相矛盾
 */
function fmtExpiry(iso, withRemain = true) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getMonth() + 1}月${t.getDate()}日 ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  if (!withRemain) return stamp;
  const leftMs = t.getTime() - Date.now();
  if (leftMs <= 0) return `${stamp}（已过期）`;
  const h = Math.floor(leftMs / 3600000);
  const m = Math.round((leftMs % 3600000) / 60000);
  return `${stamp}（还有 ${h > 0 ? `${h} 小时` : ''}${h > 0 && m > 0 ? ' ' : ''}${h === 0 || m > 0 ? `${m} 分钟` : ''}）`;
}

function section(title, ...children) {
  return el('section', { class: 'sec' }, el('h2', { class: 'sec-title' }, title), ...children);
}

function collapsible(title, ...children) {
  const body = el('div', { class: 'sec-body collapsed' }, ...children);
  const head = el('h2', { class: 'sec-title toggle' }, title, el('span', { class: 'caret' }, '▸'));
  head.addEventListener('click', () => {
    body.classList.toggle('collapsed');
    head.classList.toggle('open');
  });
  return el('section', { class: 'sec' }, head, body);
}

/** 默认展开的折叠区块（灯光面板内容多，但希望进来就能调） */
function collapsibleOpen(title, ...children) {
  const node = collapsible(title, ...children);
  node.querySelector('.sec-body')?.classList.remove('collapsed');
  node.querySelector('.sec-title')?.classList.add('open');
  return node;
}
