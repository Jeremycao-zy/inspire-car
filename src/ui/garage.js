/**
 * garage.js — 「灵感车库」第一层入口页（白色科技车库风）
 *
 * · 顶部：Logo + 灵感车库 品牌 + 新建方案按钮（对齐）
 * · Hero：标签语 + 实时 3D 车模预览（my-car.glb 自动旋转）+ CTA
 * · 我的改装方案：卡片网格，封面用保存时的 3D 快照
 *
 * 存储：localStorage key = `inspire-car-plans`
 * 点击卡片 / 新建 → onEnter(plan) 进入第二层 TUNING STUDIO
 * 第二层返回时调用 upsertPlan(rec) 保存并刷新卡片
 */

import * as THREE from 'three';
import { loadGLB, boxOf } from '../core/glb.js';
import { previewEngine, previewParamsOf } from './planPreview.js';
import './garage.css';
import logoIconUrl from '../assets/logo-icon.png';

const STORAGE_KEY = 'inspire-car-plans';

/** 默认示例方案（首次进入时展示，封面留空走占位） */
const DEMO_PLANS = [
  {
    id: 'demo-1',
    title: '小米 SU7 赛道版',
    cover: '',
    updatedAt: Date.now() - 86400000 * 2,
    desc: '前 255/35 R19 后 285/30 R19，-1.5° 倾角 flush 姿态',
    tags: ['轿车', '运动'],
  },
  {
    id: 'demo-2',
    title: '特斯拉 Model 3 低趴',
    cover: '',
    updatedAt: Date.now() - 86400000 * 5,
    desc: '9.5J ET28 齐平翼子板，HellaFlush 风格',
    tags: ['电动车', '低趴'],
  },
  {
    id: 'demo-3',
    title: '宝马 M4 G82 宽体',
    cover: '',
    updatedAt: Date.now() - 86400000 * 12,
    desc: '前 9.5J ET22 后 11J ET18，宽体大抛边',
    tags: ['跑车', '宽体'],
  },
];

function $(sel) {
  return document.querySelector(sel);
}

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

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function readPlans() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}

function writePlans(plans) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
  } catch {
    /* ignore */
  }
}

function getPlans() {
  const stored = readPlans();
  if (stored && stored.length) return stored;
  writePlans(DEMO_PLANS);
  return DEMO_PLANS;
}

function upsertPlan(plan) {
  const plans = readPlans() || [];
  const idx = plans.findIndex((p) => p.id === plan.id);
  if (idx >= 0) plans[idx] = plan;
  else plans.unshift(plan);
  writePlans(plans);
  return plans;
}

/* ---------------------------- 3D 预览（Hero） ---------------------------- */

function startPreview(container) {
  let disposed = false;
  let renderer, scene, camera, ro, model, pivot, raf;

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return { resume() {}, pause() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  camera.position.set(4.4, 1.7, 5.4);
  camera.lookAt(0, 0.1, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xc2ccd6, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(5, 8, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
  fill.position.set(-6, 3, -4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(0, 4, -7);
  scene.add(rim);

  // 软接触阴影
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShadowMaterial({ opacity: 0.16 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -1.2;
  scene.add(shadow);

  ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  loadGLB('/models/my-car.glb')
    .then(({ group }) => {
      if (disposed) return;
      pivot = new THREE.Group();
      const box = boxOf(group);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      group.position.sub(center); // 以轮心/几何中心为原点
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      pivot.scale.setScalar(3.0 / maxDim);
      pivot.add(group);
      scene.add(pivot);
    })
    .catch((e) => {
      console.warn('[garage-preview] 车模载入失败', e);
    });

  let auto = true;
  function loop() {
    if (pivot && auto) pivot.rotation.y += 0.004;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  loop();

  return {
    resume() {
      auto = true;
    },
    pause() {
      auto = false;
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      renderer?.dispose();
    },
  };
}

/* ---------------------------- 卡片 ---------------------------- */

function createCard(plan, onClick, onDelete) {
  // 缩略图容器：实时 3D 预览（动态旋转）画布由 PreviewEngine 挂载
  const thumb = el('div', { class: 'garage-card__thumb' });

  if (!previewEngine.ok) {
    // WebGL 不可用时退化成占位提示
    thumb.appendChild(el('div', { class: 'garage-card__placeholder' }, '3D 预览不可用'));
  }

  const badge = plan.tags?.[0]
    ? el('span', { class: 'garage-card__badge' }, plan.tags[0])
    : null;

  // 删除按钮（覆盖在缩略图左上角）
  const del = el(
    'button',
    {
      class: 'garage-card__delete',
      title: '删除此方案',
      'aria-label': '删除此方案',
      onClick: (e) => {
        e.stopPropagation();
        onDelete?.(plan);
      },
    },
    '×'
  );

  const card = el(
    'article',
    { class: 'garage-card', onClick: () => onClick(plan) },
    el('div', { class: 'garage-card__thumb' }, thumb, badge, del),
    el(
      'div',
      { class: 'garage-card__info' },
      el('h3', { class: 'garage-card__title' }, plan.title),
      el(
        'div',
        { class: 'garage-card__meta' },
        el('span', {}, `更新于 ${formatDate(plan.updatedAt)}`),
        el('span', { class: 'garage-card__meta-dot' }),
        el('span', {}, '实时 3D')
      ),
      plan.desc ? el('p', { class: 'garage-card__desc' }, plan.desc) : null
    ),
    el('button', { class: 'garage-card__action', onClick: (e) => { e.stopPropagation(); onClick(plan); } }, '进入改装 →')
  );

  // 卡片进入 DOM 后再挂载预览（需要 clientWidth/Height）；透传方案车型地址
  if (previewEngine.ok) {
    requestAnimationFrame(() => previewEngine.mount(thumb, previewParamsOf(plan), plan.carModelUrl));
  }
  return card;
}

function createEmptyState(onNew) {
  return el(
    'div',
    { class: 'garage-empty' },
    el('div', { class: 'garage-empty__icon' }, '🏎️'),
    el('h3', { class: 'garage-empty__title' }, '还没有改装方案'),
    el('p', { class: 'garage-empty__hint' }, '上传一张照片，开始你的第一个 3D 改装方案'),
    el('button', { class: 'gb-btn primary', onClick: onNew }, '+ 新建方案')
  );
}

/* ---------------------------- 挂载 ---------------------------- */

export function mountGarage({ onEnter, mount } = {}) {
  const root = mount || $('#garage');
  if (!root) return null;
  root.innerHTML = '';

  let preview = null;

  /* 顶部品牌栏 */
  const header = el(
    'header',
    { class: 'garage-header' },
    el(
      'div',
      { class: 'garage-brand' },
      el('img', { class: 'garage-logo', src: logoIconUrl, alt: 'INSPIRE CAR' }),
      el(
        'div',
        { class: 'garage-brand__text' },
        el('h1', { class: 'garage-brand__title' }, '灵感车库'),
        el('p', { class: 'garage-brand__sub' }, 'INSPIRE CAR · TUNING STUDIO')
      )
    ),
    el('button', { class: 'gb-btn primary', onClick: () => onEnter?.(null) }, '+ 新建方案')
  );

  /* Hero：文案 + 实时 3D 预览 */
  const heroCanvas = el('div', { class: 'garage-hero__canvas' });
  const hero = el(
    'section',
    { class: 'garage-hero' },
    el(
      'div',
      { class: 'garage-hero__text' },
      el('h2', { class: 'garage-hero__title' }, '把灵感，变成可改装的 3D'),
      el('p', { class: 'garage-hero__sub' }, '上传爱车照片，AI 生成 3D 车模，保存每一套轮毂与姿态方案。'),
      el(
        'div',
        { class: 'garage-hero__actions' },
        el('button', { class: 'gb-btn primary', onClick: () => onEnter?.(null) }, '+ 新建改装方案'),
        el('button', { class: 'gb-btn ghost', onClick: () => $('#garage-grid')?.scrollIntoView({ behavior: 'smooth' }) }, '查看我的方案')
      )
    ),
    el(
      'div',
      { class: 'garage-hero__preview' },
      el('span', { class: 'garage-hero__badge' }, '● 实时 3D 预览'),
      heroCanvas
    )
  );

  /* 方案网格 */
  const grid = el('div', { class: 'garage-grid', id: 'garage-grid' });
  const body = el(
    'main',
    { class: 'garage-body' },
    el('h2', { class: 'garage-section-title' }, '我的改装方案'),
    grid
  );

  root.appendChild(header);
  root.appendChild(hero);
  root.appendChild(body);

  function renderGrid() {
    // 重绘前先卸载所有预览，释放本实例专属资源（几何 / 场景）
    previewEngine.clear();
    grid.innerHTML = '';
    const plans = getPlans();
    if (plans.length) {
      for (const p of plans) grid.appendChild(createCard(p, (pl) => onEnter?.(pl), deletePlan));
    } else {
      grid.appendChild(createEmptyState(() => onEnter?.(null)));
    }
  }

  /** 删除某个方案（带二次确认），并刷新卡片网格 */
  function deletePlan(plan) {
    if (!plan) return;
    const name = plan.title || '未命名方案';
    if (!window.confirm(`确定删除「${name}」？此操作不可撤销。`)) return;
    const plans = (readPlans() || []).filter((p) => p.id !== plan.id);
    writePlans(plans);
    renderGrid();
  }

  renderGrid();

  // DOM 就绪后启动预览（需要拿到 clientWidth/Height）
  requestAnimationFrame(() => {
    preview = startPreview(heroCanvas);
  });

  return {
    root,
    hide() {
      root.classList.add('hidden');
      preview?.pause();
    },
    show() {
      root.classList.remove('hidden');
      renderGrid();
      preview?.resume();
    },
    refresh() {
      renderGrid();
    },
    upsertPlan(plan) {
      upsertPlan(plan);
      renderGrid();
    },
  };
}
