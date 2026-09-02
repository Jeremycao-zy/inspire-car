/**
 * garage.js — 「灵感车库」第一层入口页（白色科技车库风）
 *
 * · 顶部：Logo + 灵感车库 品牌
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
import { currentUser, logout } from '../auth.js';
import { openPricingModal } from './subscribe.js';
import './garage.css';
import logoMarkUrl from '../assets/logo-mark-neon.png';

/**
 * 方案按登录用户隔离：每个用户一套命名空间，互不串台。
 * 未登录（理论上进不到这里）回落到 anon，避免 KeyError。
 */
function storageKey() {
  const u = currentUser();
  return `inspire-car-plans:${u?.id || 'anon'}`;
}

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

/** 灵感车库「风火轮风格」玩具卡背 logo SVG（替代原 Hot Wheels logo） */
function inspireLogoSVG() {
  return `<svg class="garage-card__logo" viewBox="0 0 220 70" xmlns="http://www.w3.org/2000/svg" aria-label="灵感改装 INSPIRE CAR">
    <defs>
      <linearGradient id="hwFlame" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#e60012"/>
        <stop offset=".45" stop-color="#ff6a00"/>
        <stop offset="1" stop-color="#ffd700"/>
      </linearGradient>
      <filter id="hwShadow">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity=".28"/>
      </filter>
    </defs>
    <path d="M12,52 C12,52 25,12 70,18 C95,21 115,35 140,32 C170,28 185,10 208,20 C200,40 180,55 140,56 C100,57 60,60 25,58 C18,57 12,52 12,52 Z"
          fill="url(#hwFlame)" filter="url(#hwShadow)" stroke="#fff" stroke-width="2"/>
    <path d="M30,48 C40,25 80,28 110,38 C130,44 150,38 175,32" fill="none" stroke="#fff7b3" stroke-width="3" stroke-linecap="round" opacity=".9"/>
    <text x="108" y="43" text-anchor="middle" font-size="24" font-weight="900" fill="#fff"
          stroke="#a30e0e" stroke-width=".6" style="font-style:italic">灵感改装</text>
    <text x="108" y="60" text-anchor="middle" font-size="8" font-weight="800" fill="#1b2a44" letter-spacing="3">INSPIRE CAR</text>
  </svg>`;
}

/** 背卡车型剪影（侧视跑车轮廓） */
function carSilhouetteSVG() {
  return `<svg viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M18,58 C14,58 12,55 12,51 C12,46 16,42 22,40 L38,37 C44,30 55,24 70,22 L95,20 C105,18 118,18 130,22 L150,28 C165,32 175,38 182,45 L188,48 C193,50 196,54 195,58 C194,62 189,64 182,64 L168,64 C164,68 156,70 148,68 C140,70 132,68 128,64 L68,64 C64,68 56,70 48,68 C40,68 32,66 28,62 L22,62 C20,62 18,60 18,58 Z"
          fill="currentColor"/>
  </svg>`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function readPlans() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) return migrateLegacyRedPaint(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 一次性迁移：早期版本默认车漆是竞速红 #c8102e，改默认白色之前保存的
 * 存量方案里都带着这个红值，进改装间恢复参数时整车会变红。
 * 统一洗成 #ffffff（白色着色叠加 = 透出原车贴图，保持原有状态显示）。
 * 用 flag 保证只跑一次，用户之后主动选的红色不会被误清。
 */
function migrateLegacyRedPaint(plans) {
  if (!Array.isArray(plans)) return plans;
  const flagKey = storageKey() + ':red-paint-migrated';
  try {
    if (localStorage.getItem(flagKey)) return plans;
    localStorage.setItem(flagKey, '1');
  } catch {
    /* ignore */
  }
  let changed = false;
  for (const p of plans) {
    const c = p?.params?.bodyColor;
    if (typeof c === 'string' && c.toLowerCase() === '#c8102e') {
      p.params.bodyColor = '#ffffff';
      p.params.bodySolid = false;
      changed = true;
    }
  }
  if (changed) writePlans(plans);
  return plans;
}

function writePlans(plans) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(plans));
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
  // 原为 (4.4, 1.7, 5.4)（视距 ≈ 7.15，车仅占画布宽约 35%）。
  // 沿同一视线方向把相机拉近到视距 ≈ 3.57（正好为一半），车模放大正好 2×。
  // Hero 画布实测约 572×260（aspect ≈ 2.2）：车旋转到最宽投影 3.31 时约占宽 58%、
  // 占高 43%，仍有余量不溢出；窄屏单列（aspect ≈ 1.5）时约占宽 83%，仍在框内。
  camera.position.set(2.2, 0.9, 2.7);
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

  loadGLB('/models/my-car.glb', { progress: false })
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

  /* 复合转动：Y 轴匀速自转 + X 轴俯仰摆动 + Z 轴轻微侧摆。
     三轴用互不相同的频率，形成不重复的李萨如式姿态变化。

     为什么 X 轴是"摆动"而不是连续翻滚：
       车翻过来会露出底盘，展示效果很怪。小幅俯仰（±12°左右）既让动作
       明显变复杂，又始终保持车顶朝上、姿态可读。

     为什么用 dt 时间累积而不是每帧固定增量：
       固定增量会让转速随帧率漂移（120Hz 屏快一倍）。按秒累积才是真匀速。 */
  const SPIN = {
    yawSpeed: 0.24, // Y 轴自转角速度（弧度/秒，约 14°/s）
    pitchAmp: 0.21, // X 轴俯仰摆幅（弧度，约 ±12°）
    pitchHz: 0.09,  // X 轴摆动频率（Hz，周期约 11s）
    rollAmp: 0.05,  // Z 轴侧摆摆幅（弧度，约 ±3°）
    // 与 pitchHz 的比值取黄金比例（0.09 / 1.618）：无理数比 → 两轴永不同步，
    // 姿态不会周期性重复。若取 1.5、2 这类整数/有理比，每 20 来秒就会转回原样。
    rollHz: 0.0556, // Z 轴摆动频率（Hz，周期约 18s）
  };

  let auto = true;
  let yaw = 0;
  let phase = 0;
  let lastT = 0;

  function loop(now) {
    // dt 限幅：切后台再切回来时时间戳会跳很大，不限制会让车瞬间转过一大截
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
    lastT = now;

    if (pivot && auto) {
      yaw += SPIN.yawSpeed * dt;
      phase += dt;
      pivot.rotation.y = yaw;
      pivot.rotation.x = Math.sin(phase * SPIN.pitchHz * Math.PI * 2) * SPIN.pitchAmp;
      pivot.rotation.z = Math.sin(phase * SPIN.rollHz * Math.PI * 2) * SPIN.rollAmp;
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

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
  // 缩略图容器：实时 3D 预览（动态旋转）画布由 PreviewEngine 挂载，最终嵌在塑料泡壳里
  const thumb = el('div', { class: 'garage-card__thumb' });

  if (!previewEngine.ok) {
    // WebGL 不可用时退化成占位提示
    thumb.appendChild(el('div', { class: 'garage-card__placeholder' }, '3D 预览不可用'));
  }

  // 收藏系列标签（风火轮风格右上角小徽章）
  const badge = plan.tags?.[0]
    ? el('span', { class: 'garage-card__badge' }, plan.tags[0])
    : null;

  // 删除按钮（收藏卡左上角，随卡片 3D 浮动）
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

  // 顶部零售吊牌挂孔
  const hangHole = el('div', { class: 'garage-card__hang-hole' });

  // 背卡印刷车型剪影（放在车型文字背后作装饰）
  const silhouette = el('div', { class: 'garage-card__silhouette', html: carSilhouetteSVG() });

  // 透明塑料泡壳：绝对定位在 blister-zone 内，不再压住下方文字
  const shell = el(
    'div',
    { class: 'garage-card__shell' },
    thumb,
    el('div', { class: 'garage-card__blister-highlight' }),
    el('div', { class: 'garage-card__blister-glare' }),
    el('div', { class: 'garage-card__blister-rim' }),
    el('div', { class: 'garage-card__blister-refraction' })
  );
  const blister = el('div', { class: 'garage-card__blister' }, shell);

  // 泡壳占位区：在背卡流式布局中占据固定高度，避免与文字重叠
  const blisterZone = el('div', { class: 'garage-card__blister-zone' }, blister);

  // 背卡：品牌 logo + 泡壳占位区 + 车型信息 + 底部元数据
  const backing = el(
    'div',
    { class: 'garage-card__backing' },
    el(
      'div',
      { class: 'garage-card__brand' },
      el('div', { class: 'garage-card__logo-wrap', html: inspireLogoSVG() }),
      el('div', { class: 'garage-card__series' }, 'COLLECTOR EDITION · 收藏版')
    ),
    blisterZone,
    el(
      'div',
      { class: 'garage-card__model' },
      el('h3', { class: 'garage-card__title' }, plan.title || '未命名方案'),
      plan.desc ? el('p', { class: 'garage-card__desc' }, plan.desc) : null,
      silhouette
    ),
    el(
      'div',
      { class: 'garage-card__footer' },
      el('span', { class: 'garage-card__footer-live' }, '● 实时 3D'),
      el('span', { class: 'garage-card__footer-action' }, '进入改装 →')
    )
  );

  // 整包 = 吊牌孔 + 背卡 + 徽章 + 删除按钮（全部放在 pack 内，跟随 3D 联动）
  const pack = el('div', { class: 'garage-card__pack' }, hangHole, backing, badge, del);

  const card = el('article', { class: 'garage-card', onClick: () => onClick(plan) }, pack);

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
  root.classList.remove('hidden');

  let preview = null;

  /* 顶部品牌栏 */
  const u = currentUser();
  const userChip = el(
    'div',
    { class: 'garage-userchip' },
    el('span', { class: 'garage-userchip__name' }, u?.username || '用户'),
    el(
      'button',
      {
        class: 'garage-userchip__btn',
        type: 'button',
        title: '注销登录',
        onClick: () => logout(),
      },
      '注销'
    )
  );
  const subscribeBtn = el(
    'button',
    {
      class: 'garage-subscribe-btn',
      type: 'button',
      title: '查看订阅方案',
      onClick: () => openPricingModal(),
    },
    el('img', {
      class: 'garage-subscribe-icon',
      src: '/icons/subscribe-car.png',
      alt: '',
      'aria-hidden': 'true',
    }),
    '订阅方案'
  );

  const header = el(
    'header',
    { class: 'garage-header' },
    el(
      'div',
      { class: 'garage-brand' },
      el('img', { class: 'garage-logo', src: logoMarkUrl, alt: 'INSPIRE CAR' }),
      el(
        'div',
        { class: 'garage-brand__text' },
        el('h1', { class: 'garage-brand__title' }, '灵感改装'),
        el('p', { class: 'garage-brand__sub' }, 'INSPIRE CAR')
      ),
      subscribeBtn
    ),
    userChip
  );

  /* Hero：文案 + 实时 3D 预览 */
  const heroCanvas = el('div', { class: 'garage-hero__canvas' });
  const hero = el(
    'section',
    { class: 'garage-hero' },
    el(
      'div',
      { class: 'garage-hero__text' },
      el('h2', { class: 'garage-hero__title' }, '把灵感，变现实'),
      el('p', { class: 'garage-hero__sub' }, '看见每一套轮毂与姿态方案。'),
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
    el('h2', { class: 'garage-section-title' }, 'INSPIRATION GARAGE'),
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
