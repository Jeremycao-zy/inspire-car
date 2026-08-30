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

/** 装配微调：前后轴各一个独立参数，同样受作用域控制 */
const FINE_PARAMS = [
  { keyF: 'trackF', keyR: 'trackR', label: '轮距微调', unit: 'mm', min: -60, max: 60, step: 1, hint: '正 = 整体外扩' },
  { keyF: 'axleF', keyR: 'axleR', label: '轴位置前后', unit: 'mm', min: -150, max: 150, step: 5, hint: '正 = 往车头方向移' },
  { key: 'carLength', label: '车长校准', unit: 'm', min: 3.4, max: 6.2, step: 0.05, hint: '图生 3D 尺度不定，按真车校正', global: true },
  { key: 'suspensionDelta', label: '悬挂高低 Δ', unit: 'mm', min: -10, max: 75, step: 1, hint: 'Δ>0 降低车身；与车身升降叠加成最终偏移', global: true },
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

/** 曝光滑杆范围（与场景预设无关，用户随时可覆盖） */
const EXPOSURE = { min: 0.3, max: 2.5, step: 0.01 };

/* ---------------------------- 上传区 ---------------------------- */

function makeUploader({ title, hint, onFiles }) {
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

  // 任务名称：由视觉模型识别后自动填入，也允许手动修改
  const nameInput = el('input', {
    type: 'text',
    class: 'task-name',
    placeholder: '上传后自动识别车型，可手动修改',
    maxlength: '40',
  });
  const nameWrap = el(
    'div',
    { class: 'task-name-wrap' },
    el('label', { class: 'task-name-label' }, '任务名称'),
    nameInput
  );
  // 识别状态提示（识别中 / 已识别 / 未配置识别模型）
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
    recog
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

  /** 按当前作用域读一个参数 */
  function readVal(spec) {
    const t = app.params.axleTarget;
    if (spec.global) return app.params[spec.key];
    if (spec.keyF) return t === 'rear' ? app.params[spec.keyR] : app.params[spec.keyF];
    return t === 'rear' ? app.params.rear[spec.key] : app.params.front[spec.key];
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
    const input = el('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, id: spec.key, name: spec.key });

    const render = () => {
      const d = decimals(spec);
      const t = app.params.axleTarget;
      input.value = readVal(spec);

      let txt;
      if (spec.global) {
        txt = `${Number(readVal(spec)).toFixed(d)} ${spec.unit}`;
      } else if (t === 'all') {
        const fv = spec.keyF ? app.params[spec.keyF] : app.params.front[spec.key];
        const rv = spec.keyF ? app.params[spec.keyR] : app.params.rear[spec.key];
        txt =
          Math.abs(fv - rv) > 1e-9
            ? `前${fv.toFixed(d)} / 后${rv.toFixed(d)} ${spec.unit}`
            : `${fv.toFixed(d)} ${spec.unit}`;
      } else {
        txt = `${Number(readVal(spec)).toFixed(d)} ${spec.unit}`;
      }
      valueLabel.textContent = txt;
    };

    input.addEventListener('input', () => {
      writeVal(spec, parseFloat(input.value));
      onChange?.();
      render();
    });

    render();
    sliders.push({ render });

    return el(
      'div',
      { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, spec.label), valueLabel),
      input,
      spec.hint ? el('div', { class: 'ctl-hint' }, spec.hint) : null
    );
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
    hint: '建议 3–5 张：正面、侧面、斜 45°；生成后自动装配 4 只',
    onFiles: (files) => app.generateWheel(files),
  });

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
    '车身最终升降 = 车身升降（含 Plus Sizing 标定）− 悬挂降低 Δ'
  );

  /* ---- 微调 ---- */
  const fineBox = el(
    'div',
    { class: 'fine' },
    ...FINE_PARAMS.map((spec) =>
      makeSlider(spec, () => {
        if (spec.key === 'carLength') app.rescaleCar(app.params.carLength);
        else app.apply();
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
      el('button', { class: 'btn ghost', onclick: () => app.rotateCar(1) }, '车身转 90°'),
      el('button', { class: 'btn ghost', onclick: () => app.rotateCar(-1) }, '转 -90°'),
      el('button', { class: 'btn ghost', onclick: () => app.reset() }, '重置参数')
    )
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

  /* ---- 顶层功能分层级：整车 / 轮毂 / 车漆 / 场景 ---- */
  const TABS = [
    ['body', '整车'],
    ['wheels', '轮毂'],
    ['paint', '车漆'],
    ['bang', '拆解'],
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

  tabBodies.body.appendChild(section('整车模型', carUpload.zone));
  tabBodies.body.appendChild(section('装配微调', fineBox));
  tabBodies.wheels.appendChild(section('轮毂模型', wheelUpload.zone));
  tabBodies.wheels.appendChild(section('轮毂校准（生成模型摆位不正时微调）', rimCalibBox));
  tabBodies.wheels.appendChild(section('轮毂参数', paramBox));
  tabBodies.paint.appendChild(section('车漆', colorWheel.root));

  /* ---- BANG 拆解（Hyper3D）：把车模拆成车身 / 轮毂等可编辑部件 ----
   * 这三个参数是"一次性提交参数"，不属于 app.params（不随方案持久化），
   * 所以这里用局部 state 而不是 makeSlider（makeSlider 绑定的是 app.params）。 */
  const bangState = { strength: 5, resolution: 'Basic', material: 'PBR' };
  const bangStrengthValue = el('span', { class: 'ctl-value' }, String(bangState.strength));
  const bangStrengthInput = el('input', {
    type: 'range',
    min: 2,
    max: 12,
    step: 1,
    value: bangState.strength,
    oninput: (e) => {
      bangState.strength = Number(e.target.value);
      bangStrengthValue.textContent = String(bangState.strength);
    },
  });
  const bangRunBtn = el('button', { class: 'btn primary' }, '拆解当前车模');
  const bangClearBtn = el('button', { class: 'btn ghost' }, '清除拆解');

  let bangBusy = false;
  bangRunBtn.onclick = async () => {
    if (bangBusy) return;
    bangBusy = true;
    bangRunBtn.disabled = true;
    bangRunBtn.textContent = '拆解中…';
    try {
      await app.bangCurrentCar({ ...bangState });
    } finally {
      bangBusy = false;
      bangRunBtn.disabled = false;
      bangRunBtn.textContent = '拆解当前车模';
    }
  };
  bangClearBtn.onclick = () => app.clearBang();

  const bangBox = el(
    'div',
    { class: 'fine' },
    el(
      'div',
      { class: 'ctl' },
      el(
        'div',
        { class: 'ctl-head' },
        el('label', { class: 'ctl-label' }, '拆解力度 strength'),
        bangStrengthValue
      ),
      bangStrengthInput,
      el('div', { class: 'ctl-hint' }, '2 = 只拆大件；12 = 拆到很碎。支持递归：先拆出轮子，再对轮子单独拆')
    ),
    el(
      'div',
      { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, '贴图分辨率')),
      el(
        'select',
        { class: 'cw-select', onchange: (e) => (bangState.resolution = e.target.value) },
        el('option', { value: 'Basic' }, 'Basic（2K）'),
        el('option', { value: 'High' }, 'High（4K）')
      )
    ),
    el(
      'div',
      { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('label', { class: 'ctl-label' }, '材质')),
      el(
        'select',
        { class: 'cw-select', onchange: (e) => (bangState.material = e.target.value) },
        ...['PBR', 'Shaded', 'All', 'None'].map((m) => el('option', { value: m }, m))
      )
    ),
    el('div', { class: 'btn-row' }, bangRunBtn, bangClearBtn),
    el('div', { class: 'ctl-hint' }, '拆解后各部件会在场景中一字排开；未配置 Hyper3D Key 时走离线演示（原样返回单部件）')
  );
  tabBodies.bang.appendChild(section('BANG 拆解', bangBox));

  tabBodies.scene.appendChild(section('场景', sceneBox));
  tabBodies.scene.appendChild(collapsibleOpen('灯光', lightBox));
  tabBodies.scene.appendChild(section('视角', views));

  mount.appendChild(
    el(
      'div',
      { class: 'panel' },
      el(
        'header',
        { class: 'panel-head' },
        el('h1', {}, 'TUNING STUDIO'),
        el('p', { class: 'sub' }, '照片 → 混元 3D → GLB → 四轮实时装配')
      ),
      modeBadge,
      tabsBar,
      // 由 TABS 派生而不是逐个手写：新增 Tab 时不会漏挂对应的 body
      // （曾经因为手写列表漏挂，导致点了 Tab 所有面板都隐藏）
      ...TABS.map(([id]) => tabBodies[id])
    )
  );

  setTab('body');

  syncSeg();
  syncScene();
  syncExposure();
  rebuildLights();

  function syncAll() {
    syncSeg();
    syncScene();
    syncPrec();
    syncExposure();
    for (const s of sliders) s.render();
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
    const { state = 'unknown', expiresAt = '', rejected = false, note = '', onRefresh } = s || {};

    const TEXT = {
      live: {
        icon: '●',
        title: 'LIVE — 已接混元 3D',
        body: '上传照片会真实生成模型，每次成功生成消耗一次额度。',
      },
      expiring: {
        icon: '◐',
        title: 'LIVE — 凭证即将过期',
        body: '现在还能生成，但建议先换一张新票，避免生成到一半失效。',
      },
      expired: {
        icon: '○',
        title: rejected ? '凭证被拒 — 无法真实生成' : '凭证已过期 — 无法真实生成',
        body: '换票后点下面的「我已更新」即可恢复，不用重启服务。',
      },
      demo: {
        icon: '○',
        title: 'DEMO — 未配置凭证',
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
          el('li', {}, '在对话里说一句「刷新混元 3D 凭证」拿新票'),
          el('li', {}, '新票会自动写进 ~/.workbuddy/tokens/hunyuan3d'),
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
