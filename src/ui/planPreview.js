/**
 * planPreview.js — 灵感车库卡片「动态旋转 3D 预览」引擎
 *
 * 设计要点（对应需求 1：每个方案卡片展示用户改装车辆的实时旋转 3D，而非静态照片）：
 *
 *   · 全车库卡片**共用一个 WebGLRenderer**（离屏 tile），每帧把各卡片场景渲染到
 *     这张离屏画布，再用 drawImage 拷到卡片自己的 2D <canvas>。
 *     → 无论有多少卡片，WebGL 上下文只有 1 个，不会撞浏览器的上下文上限。
 *
 *   · 每卡片一个独立 Scene，里面按 `plan.params` 完整重建一辆改装车：
 *     Chassis（底盘/轮距/轮心高）→ WheelRig（四轮 ET/J/倾角）→ ShellCutter（车壳三道切），
 *     所以预览里看到的姿态/轮距/轮毂和 TUNING STUDIO 里完全一致。
 *
 *   · 懒加载 + 视口可见才渲染：卡片滑入视口才构建并旋转，滑出即暂停（IntersectionObserver），
 *     长列表也不卡。
 *
 * 资源复用：carSource（GLB 只解析一次）、env 贴图 / 天空 / 装饰模板按 key 缓存，
 * 多实例共享几何与贴图，只在 instance 卸载时释放「本实例专属」的车身几何。
 */

import * as THREE from 'three';
import { loadGLB, normalizeCar, boxOf } from '../core/glb.js';
import { PRESET_CAR_URL, isPresetCarUrl } from '../core/presetCar.js';
import { WheelRig } from '../tuning/wheelRig.js';
import { Chassis } from '../tuning/chassis.js';
import { ShellCutter } from '../tuning/shellCutter.js';
import { measure } from '../tuning/shellMeasure.js';
import { getPreset, buildEnvScene, disposeEnvScene } from '../core/environments.js';
import { buildDecor, makeSkyTexture } from '../core/scenes.js';

/* 离屏渲染分辨率（宽高比 1.6，与卡片缩略图一致，drawImage 不拉伸） */
const TILE_W = 560;
const TILE_H = 350;

/** 没有 params 的方案（示例方案）回退用的默认改装参数 */
export const DEFAULT_PREVIEW_PARAMS = {
  axleTarget: 'all',
  front: { rimInch: 19, j: 8.5, et: 30, tireWidthMm: 255, aspect: 35, camber: -1.0 },
  rear: { rimInch: 19, j: 9.5, et: 31, tireWidthMm: 285, aspect: 30, camber: -1.5 },
  trackF: 0,
  trackR: 0,
  axleF: 0,
  axleR: 0,
  fenderOffsetF: 0,
  fenderOffsetR: 0,
  carLength: 4.6,
  showTire: true,
  spin: false,
  autoRotate: false,
  envId: 'studio',
  chassis: { deckHeight: null, shellLiftUser: 0, visible: false },
  shell: { enabled: true, doubleSide: true, enableC1: true, enableC2: true, enableC3: true },
};

/** 取某方案用于预览的参数（缺省回退默认） */
export function previewParamsOf(plan) {
  if (plan && plan.params && plan.params.front && plan.params.rear) return plan.params;
  return DEFAULT_PREVIEW_PARAMS;
}

/* ------------------------------------------------------------------ */
/*                          共享资源缓存                                */
/* ------------------------------------------------------------------ */

const _carPromiseByUrl = new Map();

/**
 * 按车型 GLB 地址加载车身源（只解析一次，按 URL 缓存）。
 * 优先用方案里用户提交的车型（plan.carModelUrl）；地址缺失或加载失败时
 * 回退到系统默认 SL 350 演示车，绝不因车型缺失而白屏。
 */
function loadCarSource(url) {
  const key = url || PRESET_CAR_URL;
  if (_carPromiseByUrl.has(key)) return _carPromiseByUrl.get(key);
  const p = loadGLB(key, { progress: false })
    .then(({ group }) => group)
    .catch((e) => {
      console.warn('[plan-preview] 车型载入失败，回退默认车模', key, e);
      _carPromiseByUrl.delete(key); // 失败不缓存，下次重试
      return loadCarSource(); // 回退到默认车（默认已缓存或正在加载）
    });
  _carPromiseByUrl.set(key, p);
  return p;
}

/** 深克隆车身：几何独立（供 ShellCutter 独立切割），材质与源共享 */
function deepCloneCar(src) {
  const g = src.clone(true);
  g.traverse((o) => {
    if (o.isMesh) o.geometry = o.geometry.clone();
  });
  return g;
}

/** 让整车 XZ 居中并贴地 */
function groundCar(obj) {
  obj.updateMatrixWorld(true);
  const box = boxOf(obj);
  obj.position.x -= (box.min.x + box.max.x) / 2;
  obj.position.z -= (box.min.z + box.max.z) / 2;
  obj.position.y -= box.min.y;
  obj.updateMatrixWorld(true);
}

/** 软接触阴影贴图（预览关了阴影贴图，用一张径向渐变补一块接地影） */
let _blobTex = null;
function blobShadowTexture() {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.45)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _blobTex = new THREE.CanvasTexture(c);
  _blobTex.colorSpace = THREE.SRGBColorSpace;
  return _blobTex;
}

/* ------------------------------------------------------------------ */
/*                          预览引擎                                   */
/* ------------------------------------------------------------------ */

class PreviewEngine {
  constructor() {
    this.instances = new Map();
    this.envCache = new Map(); // presetId -> PMREM 贴图
    this.skyCache = new Map(); // presetId -> 背景渐变贴图
    this.decorCache = new Map(); // decorKey -> 模板 Group（共享几何/贴图）
    this.ok = false;
    this.raf = 0;

    this._createRenderer();
    if (!this.ok) return;

    // 视口可见性：滑入才渲染/构建，滑出暂停
    if ('IntersectionObserver' in window) {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const inst = this.instances.get(e.target);
            if (!inst) continue;
            inst.visible = e.isIntersecting;
            if (inst.visible && !inst.built && !inst.building) this._build(inst);
            // 重新滑入视口 → 补一帧（卡片是静态侧视，一帧就够）
            if (inst.visible && inst.built) this._markDirty(inst);
          }
        },
        { threshold: 0.05 }
      );
    }

    /* 卡片内车模是静态侧视摆放，不需要连续渲染。改为"脏标记 + 按需渲染"：
     * 每张卡片只在构建完成 / 滑入视口 / 尺寸变化时渲染一帧，
     * 没有待渲染卡片时 RAF 完全停止。
     * 之前的 60fps 常驻循环在 iOS Safari 上是持续的 GPU 负载，
     * 和 hero 预览、studio 三个渲染循环叠在一起，足以触发系统
     * 把 WebContent 进程杀掉（页面表现为"重复出现问题"崩溃）。 */
    this.raf = 0;
    this._tick = () => {
      this.raf = 0;
      if (!this.ok) return;
      let pending = false;
      for (const inst of this.instances.values()) {
        if (!inst.built || !inst.visible || !inst.dirty) continue;
        this.renderer.render(inst.scene, inst.camera);
        inst.ctx.drawImage(this.renderer.domElement, 0, 0, inst.canvas.width, inst.canvas.height);
        inst.dirty = false;
      }
      for (const inst of this.instances.values()) {
        if (inst.built && inst.visible && inst.dirty) pending = true;
      }
      // 还有未完成的（例如本轮刚构建完又标记脏）→ 继续下一帧，否则停转
      if (pending) this.raf = requestAnimationFrame(this._tick);
    };
  }

  /** 标记一张卡片需要重绘，并确保渲染循环在跑 */
  _markDirty(inst) {
    inst.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(this._tick);
  }

  getEnvTexture(preset) {
    if (this.envCache.has(preset.id)) return this.envCache.get(preset.id);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = buildEnvScene(preset);
    let tex = null;
    try {
      const rt = pmrem.fromScene(envScene, preset.envSigma ?? 0.04);
      tex = rt.texture;
      this.envCache.set(preset.id, tex);
    } finally {
      pmrem.dispose();
      disposeEnvScene(envScene);
    }
    return tex;
  }

  getSkyTexture(preset) {
    if (!preset.sky) return null;
    if (!this.skyCache.has(preset.id)) this.skyCache.set(preset.id, makeSkyTexture(preset.sky));
    return this.skyCache.get(preset.id);
  }

  getDecorTemplate(key) {
    if (this.decorCache.has(key)) return this.decorCache.get(key);
    const tpl = buildDecor(key, null);
    this.decorCache.set(key, tpl);
    return tpl;
  }

  /* ---- 挂载一张卡片 ---- */
  mount(container, params, carModelUrl) {
    if (!container) return null;
    if (!this.ok || !this.renderer) this._createRenderer();
    if (!this.ok) return null;
    if (this.instances.has(container)) return this.instances.get(container);

    const canvas = document.createElement('canvas');
    canvas.className = 'garage-card__thumb-canvas';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(container.clientWidth * dpr)) || TILE_W;
    canvas.height = Math.max(1, Math.round(container.clientHeight * dpr)) || TILE_H;
    container.appendChild(canvas);

    const inst = {
      container,
      canvas,
      ctx: canvas.getContext('2d'),
      params: params || DEFAULT_PREVIEW_PARAMS,
      carModelUrl: carModelUrl || null, // 方案里用户提交的车型（缺省回退默认 SL 350）
      envId: (params && params.envId) || 'studio',
      scene: null,
      camera: null,
      pivot: null,
      carOuter: null,
      chassis: null,
      rig: null,
      cutter: null,
      decor: null,
      lights: [],
      visible: false,
      built: false,
      building: false,
      ro: null,
    };
    this.instances.set(container, inst);

    // 跟随卡片尺寸变化，保持画布清晰
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(container.clientWidth * dpr));
      const h = Math.max(1, Math.round(container.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    });
    ro.observe(container);
    inst.ro = ro;

    if (this.io) this.io.observe(container);
    else {
      // 无 IO 时直接构建并常显
      inst.visible = true;
      this._build(inst);
    }
    return inst;
  }

  /* ---- 卸载一张卡片 ---- */
  unmount(container) {
    const inst = this.instances.get(container);
    if (!inst) return;
    if (this.io) this.io.unobserve(container);
    inst.ro?.disconnect();
    if (inst.built) this._disposeInstance(inst);
    inst.canvas?.remove();
    this.instances.delete(container);
  }

  /** 清空全部（网格重绘前调用） */
  clear() {
    for (const c of [...this.instances.keys()]) this.unmount(c);
  }

  _build(inst) {
    if (inst.built || inst.building) return;
    inst.building = true;
    buildScene(this, inst)
      .catch((e) => console.warn('[plan-preview] 构建失败', e))
      .finally(() => {
        inst.building = false;
      });
  }

  _disposeInstance(inst) {
    try {
      inst.cutter?.release?.();
      inst.rig?.dispose?.();
      inst.chassis?.dispose?.();
      // 释放本实例专属的车身几何（材质与 carSource 共享，不释放）
      if (inst.carOuter)
        inst.carOuter.traverse((o) => {
          if (o.isMesh) o.geometry?.dispose?.();
        });
      if (inst.pivot) inst.scene.remove(inst.pivot);
      if (inst.decor) inst.scene.remove(inst.decor); // 共享模板资源，不 dispose
      for (const l of inst.lights || []) inst.scene.remove(l);
    } catch {
      /* ignore */
    }
    inst.built = false;
  }

  _createRenderer() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
      });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(TILE_W, TILE_H, false);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.ok = true;
    } catch {
      this.ok = false;
      this.renderer = null;
    }
  }

  /** 释放卡片引擎独占的 WebGL 上下文与 GPU 贴图。
   * 车库切到 studio / 拍照引导等需要 3D 大视口时，保留卡片上下文会白白占用
   * iOS Safari 的 GPU 内存；销毁后再重建，可把同时活着的上下文压到最低。 */
  disposeRenderer() {
    if (!this.ok || !this.renderer) return;
    this.clear();

    for (const t of this.envCache.values()) t?.dispose?.();
    this.envCache.clear();

    for (const t of this.skyCache.values()) t?.dispose?.();
    this.skyCache.clear();

    for (const group of this.decorCache.values()) {
      if (!group) continue;
      group.traverse((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) {
          for (const m of o.material) m?.dispose?.();
        } else if (o.material) {
          o.material?.dispose?.();
        }
      });
    }
    this.decorCache.clear();

    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer = null;
    this.ok = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }
}

/** 延迟引入，避免与 environments.js 形成循环依赖 */
/* （buildEnvScene / disposeEnvScene 已在文件顶部 import） */

/* ------------------------------------------------------------------ */
/*                       单卡片场景构建                                */
/* ------------------------------------------------------------------ */

function addPreviewLight(scene, lights, spec) {
  const color = spec.color ?? 0xffffff;
  const intensity = spec.intensity;
  let light;
  switch (spec.type) {
    case 'ambient':
      light = new THREE.AmbientLight(color, intensity);
      break;
    case 'hemisphere':
      light = new THREE.HemisphereLight(spec.sky ?? 0xffffff, spec.ground ?? 0x222222, intensity);
      break;
    case 'point':
      light = new THREE.PointLight(color, intensity, spec.distance ?? 0, spec.decay ?? 2);
      light.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      break;
    case 'spot':
      light = new THREE.SpotLight(
        color,
        intensity,
        spec.distance ?? 0,
        spec.angle ?? 0.6,
        spec.penumbra ?? 0.4,
        spec.decay ?? 2
      );
      light.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      break;
    case 'directional':
    default:
      light = new THREE.DirectionalLight(color, intensity);
      light.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      break;
  }
  light.name = `plight-${spec.id}`;
  light.visible = spec.enabled !== false;
  if (light.target && spec.type !== 'point') {
    if (spec.target) light.target.position.set(spec.target[0], spec.target[1], spec.target[2]);
    else light.target.position.set(0, 0.6, 0);
    scene.add(light.target);
    lights.push(light.target);
  }
  scene.add(light);
  lights.push(light);
  return light;
}

function fitView(pivot, camera) {
  const box = new THREE.Box3().setFromObject(pivot);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z);
  const dist = maxDim * 0.62 + size.y * 0.5 + 1.4;
  const dir = new THREE.Vector3(0.62, 0.34, 0.92).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.lookAt(center);
  camera.near = 0.1;
  camera.far = 600;
  camera.updateProjectionMatrix();
}

/** 卡片缩略图专用：侧视水平摆放，带安全边距不压泡壳 */
function fitCardSideView(pivot, camera) {
  const box = new THREE.Box3().setFromObject(pivot);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // 侧视：相机从 +Z 看向原点，车长（X 轴）在画面中水平展开
  const fovRad = (camera.fov * Math.PI) / 180;
  const padding = 1.00; // 几乎贴边，让车身尽量充满卡片
  const distX = (size.x * padding * 0.5) / Math.tan(fovRad * 0.5);
  const distY = (size.y * padding * 0.5) / Math.tan(fovRad * 0.5) / camera.aspect;
  const dist = Math.max(distX, distY, size.z * 1.5) + 0.4;

  camera.position.set(center.x, center.y + size.y * 0.06, center.z + dist);
  camera.lookAt(center);
  camera.near = 0.1;
  camera.far = 600;
  camera.updateProjectionMatrix();
}

async function buildScene(engine, inst) {
  const params = inst.params;
  const preset = getPreset(inst.envId) || getPreset('studio');

  const scene = new THREE.Scene();
  inst.scene = scene;
  scene.environment = engine.getEnvTexture(preset);
  // 卡片预览统一白底，与灵感车库白色科技风一致（不再用深色 studio 背景）
  scene.background = new THREE.Color(0xffffff);
  scene.fog = new THREE.Fog(0xffffff, preset.fog?.near ?? 40, preset.fog?.far ?? 120);

  // 灯光
  for (const spec of preset.lights) addPreviewLight(scene, inst.lights, spec);

  // 实景装饰（赛道 / 欧洲城市）——白底下不叠加深色场景，保持"只放模型"的纯净感
  if (preset.decor) {
    inst.decor = engine.getDecorTemplate(preset.decor).clone(true);
    if (inst.decor) scene.add(inst.decor);
  }

  // 车身：优先用方案里用户提交的车型，缺省回退默认 SL 350 演示车
  const src = await loadCarSource(inst.carModelUrl);
  const carGroup = deepCloneCar(src);
  const carInner = new THREE.Group();
  carInner.add(carGroup);
  const carOuter = new THREE.Group();
  carOuter.add(carInner);
  const pivot = new THREE.Group();
  pivot.add(carOuter);
  scene.add(pivot);
  inst.pivot = pivot;
  inst.carOuter = carOuter;

  normalizeCar(carInner, { targetLength: params.carLength || 4.6, groundY: 0 });
  groundCar(carOuter);

  // 预设展示车：原样完整显示，不做底盘/切轮/装配 procedural 轮毂。
  // 这样卡片里看到的是「完整模型」，而不是被切掉原车轮后再装上程序化轮毂的残缺效果。
  // 用户自己的车：走完整改装预览（切轮 + procedural 轮毂 + 姿态）。
  if (!isPresetCarUrl(inst.carModelUrl)) {
    const metrics = measure(carOuter, {
      deckHeight:
        params.chassis && Number.isFinite(params.chassis.deckHeight)
          ? params.chassis.deckHeight
          : 0.3,
    });

    // 底盘 + 车壳三道切 + 四轮
    const chassis = new Chassis(pivot);
    chassis.derive(metrics, { front: params.front, rear: params.rear });
    chassis.build();
    // 卡片预览只展示用户改装后的车身外观（车身+车轮），隐藏底盘结构，
    // 避免在缩略图里露出银色大底盘，影响玩具卡观感。
    chassis.setVisible(params.chassis?.visible === true);
    inst.chassis = chassis;

    const cutter = new ShellCutter();
    cutter.capture(carOuter);
    const plan = chassis.cutPlan();
    if (Number.isFinite(params.chassis?.deckHeight)) plan.deckHeight = params.chassis.deckHeight;
    plan.enableC1 = params.shell?.enableC1 ?? true;
    plan.enableC2 = params.shell?.enableC2 ?? true;
    plan.enableC3 = params.shell?.enableC3 ?? true;
    cutter.apply(plan, { doubleSide: params.shell?.doubleSide ?? true });
    inst.cutter = cutter;

    const rig = new WheelRig(pivot);
    rig.useProceduralWheel();
    rig.setCornerSpec(chassis.cornerSpec());
    rig.setBodyHalfWidth(metrics.bodyHalfWidth);
    rig.update(params);
    inst.rig = rig;
  }

  // 卡片内整体放大，让车模在预览区更突出，仍保留泡壳边缘安全距离
  pivot.scale.setScalar(1.08);
  pivot.updateMatrixWorld(true);

  // 软接地阴影（跟随整车一起缩放）
  const box = boxOf(pivot);
  const size = box.getSize(new THREE.Vector3());
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(size.x, size.z) * 1.15, Math.max(size.x, size.z) * 1.15),
    new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.015;
  scene.add(blob);

  // 相机
  const camera = new THREE.PerspectiveCamera(38, TILE_W / TILE_H, 0.1, 600);
  inst.camera = camera;
  fitCardSideView(pivot, camera);

  inst.built = true;
  // 构建完成（异步）后主动标记一帧：按需渲染模式下不会常驻 RAF，
  // 若不在这里补 _markDirty，卡片会停在空白画布上（IntersectionObserver
  // 不会因同一次可见再触发，导致首帧永不绘制）。
  engine._markDirty(inst);
}

/* 单例：全车库共用 */
export const previewEngine = new PreviewEngine();
