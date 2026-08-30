/**
 * main.js — 应用入口
 *
 * 装配顺序：
 *   渲染基座 → 四轮装配器 → 控制面板 → 自动载入预置模型 → 归一 → 切除原车轮 → 应用参数
 *
 * 车身用两层容器：
 *   carOuter：只承载用户的"转 90°"操作
 *   carInner：只承载自动归一（摆正朝向 / 缩放 / 居中贴地）
 * 分开存，改车长重算归一时才不会把用户调好的朝向一起冲掉。
 *
 * 参数分组：
 *   params.front / params.rear 各自持有一整套轮毂参数，
 *   params.axleTarget 决定滑杆改的是「4轮 / 前轴 / 后轴」。
 */

import * as THREE from 'three';
import { createViewer } from './core/viewer.js';
import { loadGLB, normalizeCar, normalizeWheel, boxOf, disposeObject } from './core/glb.js';
import { WheelRig, ET_REF } from './tuning/wheelRig.js';
import { Chassis } from './tuning/chassis.js';
import { ShellCutter } from './tuning/shellCutter.js';
import { measure as measureShell } from './tuning/shellMeasure.js';
import { generateModel, health, recognize, GenerateError, PRECISION_TIERS } from './api/generate.js';
import { createPanel } from './ui/panel.js';
import { mountBrandAll } from './ui/brand.js';
import { mountGarage } from './ui/garage.js';
import './ui/styles.css';

/**
 * R230 SL 演示车开箱默认值（PRD §4.8 / R2.3）—— 前后配，不再是单一套参数。
 *   前 255/35R19 on 8.5J ET30，-1.0°
 *   后 285/30R19 on 9.5J ET31，-1.5°
 */
export const AXLE_DEFAULTS_FRONT = {
  rimInch: 19, j: 8.5, et: 30, tireWidthMm: 255, aspect: 35, camber: -1.0,
};
export const AXLE_DEFAULTS_REAR = {
  rimInch: 19, j: 9.5, et: 31, tireWidthMm: 285, aspect: 30, camber: -1.5,
};
/** @deprecated 前后轴已分开，保留仅为兼容旧引用 */
export const AXLE_DEFAULTS = { ...AXLE_DEFAULTS_FRONT };

const DEFAULTS = {
  axleTarget: 'all', // 'all' | 'front' | 'rear'
  precision: 'high', // 轮毂生成精度档位：standard | high | extreme（探顶前默认 high）
  suspensionDelta: 0, // 悬挂降低量 Δ（mm），>0 降低车身（与 shellLift 叠加）
  front: { ...AXLE_DEFAULTS_FRONT },
  rear: { ...AXLE_DEFAULTS_REAR },
  trackF: 0,
  trackR: 0,
  axleF: 0,
  axleR: 0,
  // 轮毂校准安全网：对 AI 生成的轮毂做手动微调（绕轮轴旋转 + 轮平面内/轴向小幅偏移）
  rimSpinDeg: 0, // 绕轮轴旋转，单位度
  rimOffsetX: 0, // 轮平面内的横向微调，mm
  rimOffsetY: 0, // 轮平面内的竖向微调，mm
  rimOffsetZ: 0, // 沿轮轴方向的 seating 微调，mm
  fenderOffsetF: 0, // 翼子板基准补偿（mm），PRD §4.6 R3.3
  fenderOffsetR: 0,
  carLength: 4.6,
  showTire: true,
  spin: false,
  autoRotate: false,
  // 场景预设 id（来自 core/environments.js），灯光与曝光随场景切换
  envId: 'studio',
  // 底盘参数：null = 由 ShellMeasure 自动推导（derive()）
  chassis: {
    deckHeight: null, // = 车壳甲板高 = C1 底切高，默认 0.0652 × L
    shellLiftUser: 0, // 用户手动升降（mm），叠加在自动 shellLift 上
    visible: true,
  },
  // 车壳三道切割（车身降低改装必需，无 UI）
  shell: {
    enabled: true,
    doubleSide: true, // 切后转双面，否则低机位会从切口看穿
    enableC1: true, // 底切
    enableC2: true, // 侧向超限切
    enableC3: true, // 轮拱开口
  },
};

const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const sidebarEl = document.getElementById('sidebar');

const viewer = createViewer(stage);
const rig = new WheelRig(viewer.scene);
const chassis = new Chassis(viewer.scene);
const shellCutter = new ShellCutter();
const shellMetrics = { current: null };

const carOuter = new THREE.Group();
carOuter.name = 'carOuter';
const carInner = new THREE.Group();
carInner.name = 'carInner';
carOuter.add(carInner);
viewer.scene.add(carOuter);

let carGroup = null; // 当前车身 GLB 根节点
let wheelGroup = null; // 当前轮毂模板

/* ---------------------------- 加载遮罩 ---------------------------- */

const overlayText = document.getElementById('overlay-text');
function showOverlay(text) {
  overlayText.textContent = text;
  overlay.classList.add('show');
}
function hideOverlay() {
  overlay.classList.remove('show');
}
document.addEventListener('glb:progress', (e) => {
  showOverlay(`加载模型 ${e.detail.pct}%`);
});

/* ---------------------------- 品牌标识 ---------------------------- */

// 三处：侧栏顶部 / 3D 视口右下角水印 / 加载遮罩居中。
// 必须在 createPanel 之前挂，prepend 才能保证侧栏 Logo 在最上面。
mountBrandAll({ sidebar: sidebarEl, stage, overlay });

/* ---------------------------- App ---------------------------- */

const app = {
  viewer,
  rig,
  chassis,
  shellCutter,
  shellMetrics,
  params: structuredClone(DEFAULTS),

  apply() {
    rig.update(this.params);
    this.updateChassis();
    this.applySuspension();
    panel?.updateReadout();
  },

  /**
   * 悬挂降低应用：把「车身相对车轮下移 Δ」落到场景。
   *   车身最终偏移 = shellLift − Δ（与 shellLiftUser 叠加，见 panel 说明）。
   *   车轮 rig 不动；仅 carInner 与 chassis.root 下移 Δ。
   */
  applySuspension() {
    const deltaM = (this.params.suspensionDelta || 0) / 1000;
    this.chassis.setSuspension(this.params.suspensionDelta || 0);
    const deltaChanged = Math.abs(deltaM - (this._lastDeltaM ?? NaN)) >= 1e-6;
    const lift = this.chassis?.p?.shellLift ?? 0;
    const base = this._baseShellY ?? carInner.position.y;
    // 车身最终偏移 = base + shellLift − Δ
    carInner.position.y = base + lift - deltaM;
    if (!deltaChanged) return;
    this._lastDeltaM = deltaM;
    carOuter.updateMatrixWorld(true);
    // 车壳下移 → 切割世界坐标缓存必须重算（沿用 applyShellMount 机制，不重建几何）
    this.shellCutter.refresh();
  },

  /**
   * 底盘 + 车壳切割的联动更新（设计 §5.1 步骤 ⑤⑥⑨）。
   *
   * 只有「轮胎尺寸 / 底盘 / 车壳参数」变化才会真的重建：
   *   · Chassis.update()    内部按 hubY/archR 签名比对
   *   · ShellCutter.apply() 内部按 plan 序列化 _key 比对
   * 所以拖 ET / J / 倾角时两者都命中缓存，不重建 —— 这个性质必须保住。
   */
  updateChassis() {
    if (!this.chassis) return;
    const p = this.params;

    // ⑤ 底盘随轮胎尺寸更新（hubY / archR / archInnerZ / 内衬）
    this.chassis.update({ front: p.front, rear: p.rear });

    // ⑩ 车壳挂载高度：换大轮且破坏外径守恒时车身相应抬高
    this.applyShellMount();

    // ⑨ 三道切割
    if (!this.shellCutter.entries.length) return;
    if (!p.shell.enabled) {
      this.shellCutter.restore();
      return;
    }
    const plan = this.chassis.cutPlan();
    if (Number.isFinite(p.chassis.deckHeight)) plan.deckHeight = p.chassis.deckHeight;
    plan.enableC1 = p.shell.enableC1;
    plan.enableC2 = p.shell.enableC2;
    plan.enableC3 = p.shell.enableC3;
    this.shellCutter.apply(plan, { doubleSide: p.shell.doubleSide });
  },

  /**
   * 车壳挂载高度（设计 §5.2）：shellMountY = shellLift。
   *
   * ⚠️ 必须是**叠加**而不是赋值 —— normalizeCar() 已经把 carInner.position.y
   * 设成了「让车底贴地」的偏移量，直接赋 0 会把整车抬起来，
   * 三道切割的 y 阈值会全错（实测会把切除率从 11.8% 推到 48%）。
   *
   * 只在数值变化时才 refresh 世界坐标缓存（refresh 要重算 15 万面，不便宜）。
   */
  applyShellMount() {
    const lift = this.chassis?.p?.shellLift ?? 0;
    if (Math.abs(lift - (this._lastShellLift ?? NaN)) < 1e-6) return;
    this._lastShellLift = lift;
    const base = this._baseShellY ?? carInner.position.y;
    carInner.position.y = base + lift;
    carOuter.updateMatrixWorld(true);
    this.shellCutter.refresh(); // 世界坐标变了，缓存必须重算
  },

  /**
   * 摆正 + 归一 + 测量 + 推导底盘 + 切割，换车或改车长后都要走一遍。
   * 顺序严格按设计 §5.1：⑨ 切割必须在 ⑧ 注入轮位之后
   * （archR / hubY 依赖轮胎参数，顺序反了会切出错误尺寸的轮拱）。
   */
  refitCar({ recapture = true } = {}) {
    if (!carGroup) return;
    // ② 摆正 + 归一
    carInner.position.set(0, 0, 0);
    carInner.quaternion.identity();
    carInner.scale.set(1, 1, 1);
    normalizeCar(carInner, { targetLength: this.params.carLength, groundY: 0 });
    carOuter.updateMatrixWorld(true);
    // 记下归一化后的挂载基准高度，shellLift 只能在这个基础上叠加
    this._baseShellY = carInner.position.y;
    this._lastShellLift = undefined;
    // ③ XZ 居中 + 贴地
    groundCar();

    const size = boxOf(carOuter).getSize(new THREE.Vector3());
    rig.setCarSize(size);

    // ④ 车壳测量（车身半宽 / 切口轮廓）
    const metrics = measureShell(carOuter, {
      deckHeight: this.chassis.p.deckHeight || this.params.chassis.deckHeight || 0.3,
    });
    shellMetrics.current = metrics;

    // ⑤ 推导底盘参数
    this.chassis.p.shellLiftUser = this.params.chassis.shellLiftUser / 1000;
    this.chassis.derive(metrics, { front: this.params.front, rear: this.params.rear });
    // 面板覆盖了甲板高时，derive 之后再盖一次并重算派生量（skirtH 等）
    if (Number.isFinite(this.params.chassis.deckHeight)) {
      this.chassis.p.deckHeight = this.params.chassis.deckHeight;
      this.chassis.p.recomputeDerived(this.params.front, this.params.rear);
    }
    // ⑥ 构建底盘几何
    this.chassis.build();
    this.chassis.setVisible(this.params.chassis.visible);

    // ⑦ 接管车壳索引
    if (recapture) {
      this.shellCutter.capture(carOuter);
    } else {
      this.shellCutter.refresh();
    }

    // ⑧ 轮位注入（底盘是唯一真值来源）
    const spec = this.chassis.cornerSpec();
    rig.setCornerSpec(spec);
    rig.setBodyHalfWidth(metrics.bodyHalfWidth);

    // ⑨ + ⑩ 在 updateChassis() 里
    this.apply();
  },

  /* ---- 整车 ---- */
  async loadCarFromUrl(url) {
    showOverlay('正在载入整车模型…');
    try {
      const { group } = await loadGLB(url);
      if (carGroup) {
        carGroup.removeFromParent();
        disposeObject(carGroup);
      }
      carGroup = group;
      carInner.add(carGroup);

      carOuter.position.set(0, 0, 0);
      carOuter.rotation.y = 0;
      this.refitCar({ recapture: true });

      this.fitCamera();
      hideOverlay();
      return true;
    } catch (e) {
      console.error('[car]', e);
      hideOverlay();
      alert(`整车模型载入失败：${e.message}`);
      return false;
    }
  },

  /** 车长校准：重跑归一，用户转过的朝向保持不变 */
  rescaleCar(length) {
    this.refitCar({ recapture: false });
  },

  rotateCar(quarters) {
    if (!carGroup) return;
    carOuter.rotation.y += (quarters * Math.PI) / 2;
    carOuter.updateMatrixWorld(true);
    groundCar();
    // 转 90° 后长宽互换，轮位要按新的世界包围盒重算
    this.refitCar({ recapture: false });
  },

  /* ---- 轮毂 ---- */
  async loadWheelFromUrl(url) {
    showOverlay('正在载入轮毂模型…');
    try {
      const { group } = await loadGLB(url);
      const measured = normalizeWheel(group);
      if (wheelGroup) disposeObject(wheelGroup);
      wheelGroup = group;
      rig.setWheelSource(group, measured);
      this.apply();
      hideOverlay();
      return measured;
    } catch (e) {
      console.warn('[wheel] 载入失败，回退程序化轮毂：', e.message);
      rig.useProceduralWheel();
      this.apply();
      hideOverlay();
      return null;
    }
  },

  /* ---- 生成（全自动，失败分级见文件末尾 runGenerate） ---- */
  async generateCar(files) {
    await runGenerate({ kind: 'car', files });
  },

  async generateWheel(files, precision) {
    if (precision && PRECISION_TIERS[precision]) this.params.precision = precision;
    await runGenerate({ kind: 'wheel', files });
  },

  /* ---- 相机 ---- */
  fitCamera() {
    const box = new THREE.Box3();
    if (carGroup) box.union(boxOf(carOuter));
    box.union(boxOf(rig.root));
    if (box.isEmpty()) return;
    viewer.frameBox(box, 1.25);
  },

  setView(key) {
    const box = new THREE.Box3();
    if (carGroup) box.union(boxOf(carOuter));
    box.union(boxOf(rig.root));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const dist = Math.max(s.x, s.z) * 1.15 + 1.2;

    const dirs = {
      iso: new THREE.Vector3(0.75, 0.4, 0.9),
      side: new THREE.Vector3(0.02, 0.22, 1),
      front: new THREE.Vector3(1, 0.3, 0.06),
      rear: new THREE.Vector3(-1, 0.32, 0.06),
      top: new THREE.Vector3(0.03, 1, 0.08),
    };

    if (key === 'wheel') {
      const corner = rig.corners.find((x) => x.id === 'FL');
      if (!corner) return;
      const p = new THREE.Vector3();
      corner.axle.getWorldPosition(p);
      viewer.controls.target.copy(p);
      viewer.camera.position.set(p.x + 0.85, p.y + 0.35, p.z + 1.15);
      viewer.controls.update();
      return;
    }

    const d = dirs[key] || dirs.iso;
    viewer.controls.target.copy(c);
    viewer.camera.position.copy(c).addScaledVector(d.normalize(), dist);
    viewer.controls.update();
  },

  reset() {
    const t = this.params.axleTarget;
    const envId = this.params.envId;
    Object.assign(this.params, structuredClone(DEFAULTS));
    this.params.axleTarget = t;
    this.params.envId = envId; // 场景是"看法"而不是轮毂参数，重置时保留
    panel.syncAll();
    this.apply();
  },

  /* ---- 场景与灯光（转发给 viewer） ---- */

  /** 切换场景预设；灯光数量会变，通知面板重建灯光列表 */
  setEnvironment(id) {
    const applied = this.viewer.applyPreset(id);
    if (!applied) return;
    this.params.envId = applied;
    panel?.rebuildLights();
    panel?.syncScene();
  },

  setLightIntensity(id, v) {
    this.viewer.setLightIntensity(id, v);
  },

  setLightEnabled(id, on) {
    this.viewer.setLightEnabled(id, on);
  },

  setExposure(v) {
    this.viewer.setExposure(v);
  },

  resetLights() {
    this.viewer.resetLights();
  },
};

/* -------------------- 生成管线：进度 / 失败分级 / 恢复动作 -------------------- */

const KIND_META = {
  car: { label: '整车', demoUrl: '/models/my-car.glb' },
  wheel: { label: '轮毂', demoUrl: '/models/wheel.glb' },
};

/** 取该类型对应的上传区控件 */
function uploaderOf(kind) {
  return kind === 'wheel' ? panel.wheelUpload : panel.carUpload;
}

/** 载入生成好的模型，并写回一句人话状态 */
async function applyResult(kind, url) {
  const u = uploaderOf(kind);
  if (kind === 'wheel') {
    const m = await app.loadWheelFromUrl(url);
    u.setStatus(
      m
        ? `生成完成，已装配 4 只（量得直径 ${(m.diameter * 1000).toFixed(0)}mm / 宽 ${(m.width * 1000).toFixed(0)}mm）`
        : '生成完成，但模型载入异常，已用程序化轮毂兜底',
      m ? 'ok' : 'err'
    );
    return;
  }
  await app.loadCarFromUrl(url);
  u.setStatus('生成完成，已装载你的车', 'ok');
}

/**
 * 跑一次生成（新建 / 续等 / 重试），失败时按原因给出对应的恢复动作。
 *
 * 红线：任何失败都不会自动切到演示模型。要不要改用演示模型必须用户点按钮，
 *       且按钮文案与事后状态都写明"演示模型 / 不是你的车"，不允许拿预置模型冒充结果。
 *
 * @param {{kind:'car'|'wheel', files?:File[], images?:Array, resumeJobId?:string}} args
 */
async function runGenerate({ kind, files, images, resumeJobId }) {
  const u = uploaderOf(kind);
  const meta = KIND_META[kind];

  // 全新上传：先识别车型 → 回填任务名称（失败则手填，不阻塞）
  if (files) {
    u.setThumbs(files);
    u.clearRecovery();
    u.setProgress(0.01);
    u.setRecog('识别车型中…');
    u.setStatus('识别车型中…');
    const rec = await recognize(files).catch(() => null);
    if (rec?.available) {
      u.setTaskName(rec.fullName || '');
      const pct = Math.round((rec.confidence || 0) * 100);
      u.setRecog(
        `已识别：${rec.fullName || '未知车型'}${pct ? `（把握 ${pct}%）` : ''}`,
        'ok'
      );
      u.setStatus(`识别为「${rec.fullName || '未知车型'}」，开始生成…`);
    } else if (rec?.reason === 'no-key') {
      u.setRecog('未配置识别模型，可手动命名（详见对话说明）', 'warn');
      u.setStatus('未配置识别模型，开始生成（可手动填任务名称）…');
    } else {
      u.setRecog('识别失败，可手动命名', 'err');
      u.setStatus('自动识别失败，开始生成（可手动填任务名称）…');
    }
  }

  // 任务名称：优先用识别结果，其次用户手填，缺省退回中性默认
  const title = u.getTaskName();

  try {
    const res = await generateModel({
      kind,
      files,
      images,
      resumeJobId,
      title,
      precision: app.params.precision,
      onProgress: (s) => {
        u.setProgress(s.progress);
        u.setStatus(s.message);
      },
    });

    if (res.mode === 'demo') {
      // 后端处于 DEMO 模式，返回的是预置模型，必须说清楚不是用户的车
      await (kind === 'wheel' ? app.loadWheelFromUrl(res.url) : app.loadCarFromUrl(res.url));
      u.setStatus(`已载入${meta.label}演示模型（不是你上传的照片生成的，未消耗额度）`, 'warn');
      u.setDetail('配置凭证后重新上传，才会真实生成你的车。');
    } else {
      await applyResult(kind, res.url);
      const t = res.title || title || '';
      u.setStatus(t ? `已生成：${t}` : `生成完成（${meta.label}）`, 'ok');
      refreshHealth(); // 顺手刷新凭证剩余时间
    }
  } catch (e) {
    handleGenerateError(kind, e);
  } finally {
    u.setProgress(0);
  }
}

/** 失败分级 UI：凭证失效 / 本地超时 / 普通失败，各走各的恢复路径 */
function handleGenerateError(kind, e) {
  const u = uploaderOf(kind);
  const meta = KIND_META[kind];
  const reason = e instanceof GenerateError ? e.reason : 'fail';
  const images = e instanceof GenerateError ? e.images : null;

  // 所有失败路径都提供的兜底按钮，文案必须带"演示"
  const demoAction = {
    label: `改用${meta.label}演示模型（不是你的车）`,
    tone: 'ghost',
    onClick: async () => {
      u.setActions([]);
      u.setStatus(`正在载入${meta.label}演示模型…`);
      await (kind === 'wheel'
        ? app.loadWheelFromUrl(meta.demoUrl)
        : app.loadCarFromUrl(meta.demoUrl));
      u.setStatus(`当前是${meta.label}演示模型，不是你上传的照片生成的`, 'warn');
      u.setDetail('照片还留着，凭证恢复后点重试即可真实生成。');
    },
  };

  if (reason === 'auth') {
    // 记下这张票被拒了，状态卡才会显示"已失效"而不是继续报 LIVE
    if (e.tokenId) rejectedTokenIds.add(e.tokenId);
    u.setStatus('凭证已失效，这次没有真实生成（未消耗额度）', 'err');
    u.setDetail([
      '换票：在对话里说「刷新混元 3D 凭证」→ 新票写入 ~/.workbuddy/tokens/hunyuan3d → 回来点重试（不用重启服务）。',
      e.detail ? `云端返回：${e.detail}` : '',
    ]);
    u.setActions([
      {
        label: '我已换票，用同样的照片重试',
        tone: 'primary',
        onClick: async () => {
          const state = await refreshHealth();
          if (state !== 'live' && state !== 'expiring') {
            u.setStatus('凭证还是没生效，确认新票已写入后再试', 'err');
            return;
          }
          runGenerate({ kind, images });
        },
      },
      demoAction,
    ]);
    refreshHealth(); // 状态卡同步切到「已过期」
    return;
  }

  if (reason === 'timeout') {
    u.setStatus('云端还在生成，本地等待先到点了', 'warn');
    u.setDetail([
      '模型没丢：点「继续等待」会接着同一个云端任务，不重新提交、不重复消耗额度。',
      e.jobId ? `任务 ID：${e.jobId}` : '',
    ]);
    u.setActions([
      {
        label: '继续等待这个任务',
        tone: 'primary',
        onClick: () => runGenerate({ kind, images, resumeJobId: e.jobId }),
      },
      demoAction,
    ]);
    return;
  }

  // 普通失败：网络中断、云端 FAIL、下载三次都没成
  u.setStatus(`生成失败：${e.message}`, 'err');
  u.setDetail([
    '可以用同样的照片直接重试；连续失败时，换一张主体更完整、背景更干净的照片效果会明显更好。',
    e.detail ? `细节：${String(e.detail).slice(0, 200)}` : '',
  ]);
  u.setActions([
    { label: '用同样的照片重试', tone: 'primary', onClick: () => runGenerate({ kind, images }) },
    demoAction,
  ]);
}

/**
 * 被云端明确拒绝过的票（存 tokenId 短哈希）。
 *
 * 为什么要单独记：/api/health 只知道"凭证文件存不存在、里面写的过期时间到没到"，
 * 但票可能被提前吊销、也可能用户抄错一位——这两种情况下文件还在、时间还没到，
 * 云端却直接 401。只有把"这张票刚被拒过"记下来，状态卡才能如实显示已失效；
 * 等用户真换了票、tokenId 变了，自然就不在这个集合里，状态卡自动恢复。
 */
const rejectedTokenIds = new Set();

/** 把 /api/health 回包翻成状态卡的四态 */
function classifyHealth(h) {
  if (!h?.ok) return 'unknown';
  if (h.mode !== 'live') return 'demo';
  // 云端已经拒过这张票，比文件里声明的过期时间更可信
  if (h.tokenId && rejectedTokenIds.has(h.tokenId)) return 'expired';
  if (!h.expiresAt) return 'live';
  const left = new Date(h.expiresAt).getTime() - Date.now();
  if (Number.isNaN(left)) return 'live';
  if (left <= 0) return 'expired'; // 文件还在，但票已经过期
  if (left <= 2 * 3600 * 1000) return 'expiring'; // 2 小时内提醒换票
  return 'live';
}

/**
 * 重查凭证状态并重绘状态卡。
 * 后端每次请求都会重读凭证文件，所以换票后点「我已更新」即可，不需要重启服务。
 * @returns {Promise<'live'|'expiring'|'expired'|'demo'|'unknown'>}
 */
async function refreshHealth() {
  const h = await health();
  const state = classifyHealth(h);
  panel.setMode({
    state,
    expiresAt: h.expiresAt || '',
    // 区分"时间到了"和"票被云端拒了"：后者文件里写的有效期不可信，不能显示"还有 xx 小时"
    rejected: !!(h.tokenId && rejectedTokenIds.has(h.tokenId)),
    // LIVE 正常时不挂按钮，保持面板干净；其余三态都需要用户动手
    onRefresh: state === 'live' ? null : refreshHealth,
  });
  return state;
}

/* ---------------------------- 工具 ---------------------------- */

/** 让车身重新贴地并 XZ 居中 */
function groundCar() {
  carOuter.updateMatrixWorld(true);
  const box = boxOf(carOuter);
  carOuter.position.x -= (box.min.x + box.max.x) / 2;
  carOuter.position.z -= (box.min.z + box.max.z) / 2;
  carOuter.position.y -= box.min.y;
  carOuter.updateMatrixWorld(true);
}

/* ---------------------------- 启动 ---------------------------- */

let panel = null;
let tunerStarted = false;
let currentPlan = null; // 当前在第二层编辑的方案（含 id / title / params）
let garage = null; // 第一层「灵感车库」实例

function startTuner() {
  if (tunerStarted) return;
  tunerStarted = true;

  panel = createPanel(app, document.getElementById('sidebar'));

  // 车轮随动旋转
  viewer.onUpdate(() => {
    if (!app.params.spin) return;
    for (const c of rig.corners) c.axle.rotation.z -= 0.012;
  });

  (async function boot() {
    await refreshHealth();

    // 凭证会在十几小时后过期，长时间挂着页面时每 5 分钟复查一次，
    // 让"还有 x 小时"不至于停在打开页面那一刻。
    setInterval(refreshHealth, 5 * 60 * 1000);

    // 无轮毂模型时先上程序化轮毂，保证一进来就能拖滑杆看效果
    rig.useProceduralWheel();
    app.apply();

    // 预置整车 + 预置轮毂（存在才加载）
    await app.loadCarFromUrl('/models/my-car.glb');
    const wheelOk = await fetch('/models/wheel.glb', { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false);
    if (wheelOk) await app.loadWheelFromUrl('/models/wheel.glb');

    app.fitCamera();
    app.setView('iso');
  })();
}

// 调试入口：追加 chassis / shellCutter 供 CDP 验证脚本读取
window.__garage = {
  app,
  rig,
  viewer,
  THREE,
  ET_REF,
  chassis,
  shellCutter,
  shellMetrics,
  startTuner,
};

// 把当前 3D 视图截成方案封面（dataURL）
function capturePreview() {
  try {
    app.viewer.renderer.render(app.viewer.scene, app.viewer.camera);
    return app.viewer.renderer.domElement.toDataURL('image/jpeg', 0.6);
  } catch {
    return '';
  }
}

// 把方案参数注入编辑器（进入方案 / 重新进入时调用）
function applyPlanToApp(plan) {
  if (plan?.params) app.params = structuredClone(plan.params);
  if (!panel) return;
  panel.syncAll();
  if (plan?.title) panel.carUpload.setTaskName(plan.title);
  // 车已载入时按方案参数完整重算底盘 / 轮位；未载入时 boot 会用这套参数载入
  if (typeof carGroup !== 'undefined' && carGroup) app.refitCar({ recapture: false });
  else app.apply();
}

// 进入第二层 TUNING STUDIO
function enterTuner(plan) {
  currentPlan =
    plan || { id: 'plan-' + Date.now(), title: '未命名方案', params: structuredClone(DEFAULTS) };
  const garageEl = document.getElementById('garage');
  if (garageEl) garageEl.classList.add('hidden');
  startTuner();
  applyPlanToApp(currentPlan);
}

// 返回第一层：保存当前方案 → 刷新卡片 → 显示车库
function returnToGarage() {
  if (currentPlan && panel) {
    const rec = {
      id: currentPlan.id,
      title: panel.carUpload.getTaskName() || currentPlan.title || '未命名方案',
      cover: capturePreview() || currentPlan.cover || '',
      updatedAt: Date.now(),
      desc: currentPlan.desc || '',
      tags: currentPlan.tags || [],
      params: structuredClone(app.params),
    };
    garage?.upsertPlan(rec);
    currentPlan = rec;
  }
  const garageEl = document.getElementById('garage');
  if (garageEl) garageEl.classList.remove('hidden');

  // 按钮短暂反馈「已保存」
  const btn = document.getElementById('back-to-garage');
  if (btn && btn.isConnected) {
    const old = btn.textContent;
    btn.textContent = '✓ 已保存';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = old;
      btn.disabled = false;
    }, 1300);
  }
}

// 第一层入口：灵感车库（白色科技车库风）。选择方案 / 新建 → 进入 TUNING STUDIO。
garage = mountGarage({
  onEnter(plan) {
    enterTuner(plan);
  },
});

// 第二层顶部「返回灵感车库 · 保存」按钮
document.getElementById('back-to-garage')?.addEventListener('click', returnToGarage);

// 调试入口：追加 chassis / shellCutter 供 CDP 验证脚本读取
window.__garage = {
  app,
  rig,
  viewer,
  THREE,
  ET_REF,
  chassis,
  shellCutter,
  shellMetrics,
  startTuner,
  enterTuner,
  returnToGarage,
  capturePreview,
};
