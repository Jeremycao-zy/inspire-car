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
import { RIM_PRESETS } from './tuning/proceduralRim.js';
import { Chassis } from './tuning/chassis.js';
import { ShellCutter } from './tuning/shellCutter.js';
import { measure as measureShell } from './tuning/shellMeasure.js';
import { classifyDims } from './core/partClassify.js';
import {
  generateModel,
  health,
  recognize,
  fetchCarSpecs,
  bangModel,
  lookupBangParts,
  uploadPart,
  GenerateError,
  PRECISION_TIERS,
} from './api/generate.js';
import { createPanel } from './ui/panel.js';
import { mountBrandAll } from './ui/brand.js';
import { mountGarage } from './ui/garage.js';
import { recordGeneratedWheel, renderMyWheels } from './ui/myWheels.js';
import { fetchMe } from './auth.js';
import { showAuthOverlay } from './ui/auth.js';
import './ui/styles.css';

/** 文件指纹：同一张照片反复选择时 name/size/lastModified 一致，用于额度用尽后的去重拦截 */
function sigOfFiles(files) {
  return Array.from(files || [])
    .map((f) => `${f.name}:${f.size}:${f.lastModified}`)
    .join('|');
}
/** 本地日期 yyyy-mm-dd，用于判断额度是否跨天（午夜）重置 */
function todayYMD() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
  // 生成引擎：整车生成固定走 Hyper3D Rodin（用户要求去掉 fal.ai、不可选）。
  // 启动时若该引擎没配凭证，refreshHealth 会自动回退到有凭证的那个（见 ENGINE_PRIORITY）。
  engine: 'hyper3d',
  // 轮毂生成引擎：与整车分开设置，默认 Hyper3D Rodin（轮毂必须走这家，见 runGenerate）
  wheelEngine: 'hyper3d',
  falHighPack: false, // 已弃用：fal.ai HighPack（引擎已移除）
  suspensionDelta: 0, // 悬挂降低量 Δ（mm），>0 降低车身（与 shellLift 叠加）
  // 分角悬挂高度偏移（mm）。正值 = 该角车身升高，负值 = 降低；
  // 与全局 suspensionDelta 叠加。UI 提供「四轮/前轴/后轴/单角」四种作用域。
  suspension: { FL: 0, FR: 0, RL: 0, RR: 0 },
  suspensionTarget: 'all', // 'all' | 'front' | 'rear' | 'FL' | 'FR' | 'RL' | 'RR'
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
  rimPreset: 'default', // 程序化轮毂款式 id（te37 / bbs-lm / rotiform / mesh / sport / default）
  // 用户自己生成的轮毂模型 URL；rimPreset='custom' 表示当前不是预设款式
  customWheelUrl: null,
  fenderOffsetF: 0, // 翼子板基准补偿（mm），PRD §4.6 R3.3
  fenderOffsetR: 0,
  // 车长（米）。查到真车数据后会被真实车长覆盖，见 applyRealSpecs()
  carLength: 4.6,
  // 真车参数（米 / 毫米 / 度）：由识别后整理，供面板直接展示与微调。
  // null = 未查到，此时退回到默认车长并保持纯等比归一。
  carWidth: null,          // m
  carHeight: null,         // m
  wheelbase: null,         // mm
  trackFront: null,        // mm
  trackRear: null,         // mm
  // 实测前后轴的绝对 x 坐标（mm，车长中心为 0、车头 +X）。
  // 来自 BANG 拆解测到的车轮质心（bangWheelGeom.xFront / xRear）。
  // 有它才知道"轴距中心 ≠ 车身中心"这件事，只给 wheelbase 会被当成对称摆位。
  axleXFront: null,        // mm
  axleXRear: null,         // mm
  groundClearance: null,   // mm
  approachAngle: null,     // °
  departureAngle: null,    // °
  // 真车参数原始来源（毫米 / 度）：{length,width,height,wheelbase,trackFront,trackRear,groundClearance,approachAngle,departureAngle,rimInch,tireWidth,aspect,source,confidence}
  realSpecs: null,
  showTire: true,
  spin: false,
  autoRotate: false,
  // 场景预设 id（来自 core/environments.js），灯光与曝光随场景切换
  envId: 'studio',
  // 底盘参数：null = 由 ShellMeasure 自动推导（derive()）
  chassis: {
    deckHeight: null, // = 车壳甲板高 = C1 底切高，默认 0.0652 × L
    shellLiftUser: 0, // 用户手动升降（mm），叠加在自动 shellLift 上
    visible: false, // 默认隐藏程序化底盘框架，避免与用户上传车模冲突
  },
  // 车壳三道切割（车身降低改装必需，无 UI）
  shell: {
    enabled: true,
    doubleSide: true, // 切后转双面，否则低机位会从切口看穿
    enableC1: true, // 底切
    enableC2: true, // 侧向超限切
    enableC3: true, // 轮拱开口
  },
  // 车漆规则：初始一律展示模型原始材质贴图（白色着色 = 不染色、贴图原样透出），
  // 绝不默认红漆、不烘焙固定颜色；用户在车漆色轮里主动选色才上色。
  // bodySolid=true 时去掉 baseColor 贴图做纯色重喷（用户显式操作）。
  bodyColor: '#ffffff',
  bodySolid: false,
  // Hyper3D 自动 BANG 拆解视图（产物按原坐标装配回整车，不是摆到旁边的第二辆车）
  bangView: 'assembled', // assembled = 拆解装配体 / single = 未拆解整车单体
  bangExplode: 0, // 爆炸视图 0~1，0 = 完全装配
  // 按拆解实测校准出来的轮位（米）：{wheelbase, trackFront, trackRear, hubY}
  // 车轮网格本身不入场景，只把位置信息交给四轮 rig
  bangWheelGeom: null,
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

/* BANG 散件挂载点（手动导入的多个独立 GLB，一字排开摆在车旁）。
 * 独立于 carInner：这些散件不属于整车坐标系，不能参与归一/切割。 */
const bangRoot = new THREE.Group();
bangRoot.name = 'bangRoot';
viewer.scene.add(bangRoot);

/* Hyper3D 自动 BANG 的「拆解装配体」挂载点。
 *
 * 关键事实（实测 BANG 返回）：一次拆解返回的是**一个 GLB，内含多个子网格**
 * （车身 1 + 四轮 4），且子网格顶点与原始整车**完全同一坐标系**
 * （包围盒逐位相同）。所以正确做法是把它挂进 carInner、与 carGroup 共享
 * 同一套归一变换 —— 部件会精确落在整车原位，既不是"摆到旁边的第二辆车"，
 * 也不会有偏移/镂空/穿模。
 *
 * bangFit 只承载「对齐整车」的校正量（缩放 + 平移），
 * bangAssembly 承载具体部件，两者分开便于随时重算校正而不动部件坐标。 */
const bangFit = new THREE.Group();
bangFit.name = 'bangFit';
const bangAssembly = new THREE.Group();
bangAssembly.name = 'bangAssembly';
bangFit.add(bangAssembly);
carInner.add(bangFit);

/** 已挂载的拆解部件签名（url 列表），用于避免同一批部件重复挂载 */
let bangMountedSig = '';

let carGroup = null; // 当前车身 GLB 根节点
let wheelGroup = null; // 当前轮毂模板

/** 强制回到程序化轮毂，并释放当前轮毂模板 */
function resetWheelToProcedural() {
  if (wheelGroup) {
    disposeObject(wheelGroup);
    wheelGroup = null;
  }
  rig.useProceduralWheel(app.params.rimPreset);
  app.apply();
}

/** 清掉上一轮 BANG 产物，避免多次拆解叠加在同一位置 */
function clearBangParts() {
  for (const child of [...bangRoot.children]) {
    bangRoot.remove(child);
    disposeObject(child);
  }
  for (const child of [...bangAssembly.children]) {
    bangAssembly.remove(child);
    disposeBangPart(child);
  }
  bangFit.position.set(0, 0, 0);
  bangFit.scale.setScalar(1);
  bangFit.visible = true;
  bangAssembly.visible = true;
  app._bangParts = [];
  app._bangWheelParts = [];
  app._bangSpan = 1;
  delete app.params.bangWheelGeom; // 轮位校准来源于这批部件，一起作废
  app.params.axleXFront = null;
  app.params.axleXRear = null;
  bangMountedSig = '';
  // 装配体清掉后要让整车重新显形，否则场景里一辆车都没有
  if (carGroup) carGroup.visible = true;
  // 拆下来的实体车身没了 → 恢复三道切割（整车单体的车轮是画在贴图上的，必须开口）
  if (app.params.shell.enabled === false) app.params.shell.enabled = true;
  // 还原应用 BANG 时切除的原车车轮，让「清除拆解物」真正回到未拆解前的整车状态
  restoreOriginalWheels();
  // 拆解产物带来的轮位校准一并作废，轮毂也回到程序化款，避免残留异常模型
  resetWheelToProcedural();
}

/**
 * 释放一个拆解部件。
 * 只释放几何：材质是 loadGLB 升级出来的、被多个部件共用，不能在这里释放。
 */
function disposeBangPart(mesh) {
  mesh?.traverse?.((o) => {
    if (o.isMesh) o.geometry?.dispose?.();
  });
}

/**
 * 把一个 BANG 产物 GLB 拆成「一个子网格 = 一个独立部件」。
 *
 * 为什么必须拆：BANG 把拆好的多个部件塞进同一个文件的多个子网格里，
 * 直接整文件入场景就只能当成"一整辆车"，看不到任何拆解效果。
 * 子网格顶点还带着各自的节点变换 —— 必须把世界变换烘焙进几何，
 * 拆出来的每个部件才能独立移动 / 隐藏，且顶点回到整车原始坐标系。
 *
 * @param {THREE.Object3D} group loadGLB 返回的根节点
 * @returns {THREE.Mesh[]}
 */
function splitBangFile(group) {
  group.updateMatrixWorld(true);
  const parts = [];
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld); // 烘焙世界变换 → 顶点回到整车原始坐标系
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, o.material);
    mesh.name = o.name || 'bang-part';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parts.push(mesh);
  });
  // 原始几何已克隆，这里只释放源文件的几何；材质留给新部件继续用
  group.traverse((o) => {
    if (o.isMesh) o.geometry?.dispose?.();
  });
  return parts;
}

/**
 * 把装配体整体对齐到 carGroup 的世界包围盒。
 *
 * BANG 产物与整车理论上同坐标系（实测包围盒逐位相同），
 * 但换车型 / 换拆解参数后不保证永远一致 —— 这里做一次世界空间校正兜底：
 * 等比缩放 + 居中平移，误差超过 1% 才真正动手，正常情况下是恒等变换。
 */
function fitBangAssemblyToCar() {
  if (!carGroup || !bangAssembly.children.length) return;
  carOuter.updateMatrixWorld(true);
  const A = boxOf(bangAssembly);
  const B = boxOf(carGroup);
  if (A.isEmpty() || B.isEmpty()) return;
  const aSize = A.getSize(new THREE.Vector3());
  const bSize = B.getSize(new THREE.Vector3());
  const s =
    (bSize.x / (aSize.x || 1) + bSize.y / (aSize.y || 1) + bSize.z / (aSize.z || 1)) / 3;
  if (!Number.isFinite(s) || s <= 0) return;
  if (Math.abs(s - 1) < 0.01 && A.getCenter(new THREE.Vector3()).distanceTo(B.getCenter(new THREE.Vector3())) < 0.01) {
    return; // 已经对齐，不动
  }
  const m = carInner.matrixWorld;
  const linInv = new THREE.Matrix3().setFromMatrix4(m).invert();
  const tr = new THREE.Vector3().setFromMatrixPosition(m);
  const a = A.getCenter(new THREE.Vector3()).sub(tr);
  const b = B.getCenter(new THREE.Vector3()).sub(tr);
  bangFit.scale.setScalar(s);
  bangFit.position.copy(b.sub(a.multiplyScalar(s)).applyMatrix3(linInv));
  bangFit.updateMatrixWorld(true);
}

/** 车身相关的根节点：未拆解的整车 + 拆解装配体（两者都参与上色/切割） */
function bodyRoots() {
  const roots = [];
  if (carGroup) roots.push(carGroup);
  if (bangAssembly?.children?.length) roots.push(bangAssembly);
  return roots;
}

/**
 * 把拆解出的部件沿 X 轴一字排开：间距按各自尺寸自适应，统一贴地、Z 向居中。
 * 不排布的话所有部件会重叠在原点，看上去像"只有一个部件"。
 */
function layoutBangParts(groups, { offsetX = 0 } = {}) {
  const gap = 0.35;
  let cursor = 0;
  for (const g of groups) {
    g.updateMatrixWorld(true);
    const box = boxOf(g);
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    // 先算好包围盒再定位：position 会整体平移 bbox，用 box.min/center 反推即可
    g.position.set(cursor - box.min.x, -box.min.y, -center.z);
    bangRoot.add(g);
    cursor += Math.max(size.x, 0.2) + gap;
  }
  // offsetX：自动拆解时把部件摆到整车旁边，避免和原车重叠成一团
  bangRoot.position.x = offsetX - (cursor - gap) / 2;
}

/* -------------------- 原车轮切除（换轮毂用） -------------------- */

/**
 * 点是否落在某个"轮位圆柱"内。
 * 圆柱沿轮轴方向，半径 = 轮胎外半径，半宽 = 轮宽/2 + 余量。
 */
const _cv = new THREE.Vector3();
function inCylinder(p, cyl) {
  _cv.subVectors(p, cyl.center);
  const axial = _cv.dot(cyl.axis);
  if (Math.abs(axial) > cyl.halfW) return false;
  const radialSq = Math.max(0, _cv.lengthSq() - axial * axial);
  return radialSq <= cyl.R * cyl.R;
}

/** 收集四个轮位的世界空间圆柱 */
function wheelCylinders({ radiusScale = 1.2, widthPad = 0.08 } = {}) {
  rig.root.updateMatrixWorld(true);
  return rig.corners.map((c) => {
    const m = rig.live?.[c.id] || {};
    const center = new THREE.Vector3();
    c.axle.getWorldPosition(center);
    // 轮轴方向 = axle 的本地 +Z 变换到世界（轮毂沿 Z 缩放，见 wheelRig）
    const axis = new THREE.Vector3(0, 0, 1).transformDirection(c.axle.matrixWorld).normalize();
    return {
      center,
      axis,
      R: (m.r || 0.3) * radiusScale,
      halfW: (m.halfW || 0.11) + widthPad,
    };
  });
}

/**
 * 用几何把轮位圆柱"对准"实际车轮。
 *
 * 为什么需要：rig 的轮位是**按车身尺寸估算**的（autoFitCorners），与模型真实轮子
 * 系统性对不上——演示车实测：实际车轮 |z|≈0.63，估算 |z|≈0.795，偏差约 170mm。
 * 盲信估算会导致圆柱只擦到轮子外沿（只切下几千面）。
 *
 * 做法：以估算位置为种子，在其附近滑动候选圆柱中心，取"框住三角面重心最多"的那个。
 * 轴向（轮距方向）误差最大，所以沿轴搜索范围最大；径向只做小幅微调。
 * 同等命中数时偏向"离种子近"的解，避免漂到车身上。
 *
 * @returns {{cylinders:Array, drift:Array}} drift 记录每个轮位的偏移量，便于排查
 */
function refineCylindersToGeometry(
  cyls,
  { axialRange = 0.55, axialStep = 0.03, radialRange = 0.1, radialStep = 0.05 } = {}
) {
  if (!carGroup) return { cylinders: cyls, drift: [] };

  // 一次性收集车身所有三角面重心（世界坐标，扁平数组避免几十万个小对象）
  const pts = [];
  const wp = new THREE.Vector3();
  carOuter.updateMatrixWorld(true);
  carGroup.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const pos = g.attributes?.position;
    if (!pos) return;
    const index = g.index;
    const n = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < n; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      let x = 0, y = 0, z = 0;
      for (const vi of [a, b, c]) {
        wp.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        x += wp.x; y += wp.y; z += wp.z;
      }
      pts.push(x / 3, y / 3, z / 3);
    }
  });

  const out = [];
  const drift = [];

  for (const cyl of cyls) {
    const { center, axis, R, halfW } = cyl;
    const ax = axis.x, ay = axis.y, az = axis.z;

    // 只保留搜索邻域内的点，大幅降低候选遍历成本
    const reach = R + Math.max(axialRange, radialRange) + halfW;
    const near = [];
    for (let i = 0; i < pts.length; i += 3) {
      const dx = pts[i] - center.x, dy = pts[i + 1] - center.y, dz = pts[i + 2] - center.z;
      if (dx * dx + dy * dy + dz * dz <= reach * reach) near.push(pts[i], pts[i + 1], pts[i + 2]);
    }

    let best = { score: -Infinity, cx: center.x, cy: center.y, cz: center.z };
    for (let sa = -axialRange; sa <= axialRange + 1e-9; sa += axialStep) {
      const bx = center.x + ax * sa, by = center.y + ay * sa, bz = center.z + az * sa;
      for (let ox = -radialRange; ox <= radialRange + 1e-9; ox += radialStep) {
        for (let oy = -radialRange; oy <= radialRange + 1e-9; oy += radialStep) {
          const cx = bx + ox, cy = by + oy, cz = bz;
          let count = 0;
          for (let i = 0; i < near.length; i += 3) {
            const vx = near[i] - cx, vy = near[i + 1] - cy, vz = near[i + 2] - cz;
            const axial = vx * ax + vy * ay + vz * az;
            if (axial > halfW || axial < -halfW) continue;
            const radialSq = vx * vx + vy * vy + vz * vz - axial * axial;
            if (radialSq <= R * R) count += 1;
          }
          const score = count - (Math.abs(sa) + Math.abs(ox) + Math.abs(oy)) * 1e-3;
          if (score > best.score) best = { score, cx, cy, cz };
        }
      }
    }

    out.push({ center: new THREE.Vector3(best.cx, best.cy, best.cz), axis: axis.clone(), R, halfW });
    drift.push({
      moved: +Math.hypot(best.cx - center.x, best.cy - center.y, best.cz - center.z).toFixed(3),
      dz: +(best.cz - center.z).toFixed(3),
    });
  }

  return { cylinders: out, drift };
}

/**
 * 切掉车身上原有的车轮。
 *
 * 为什么必须切：实测（scripts/_probe-connected-parts.mjs）显示 AI 生成的车
 * 车轮与车身是**同一个连通块**，根本分离不出来。所以只能按四轮位置做几何切除——
 * 三角面重心落在任一轮位圆柱内就从索引里剔除，让新轮毂能装进切出的轮拱。
 *
 * 切口会露出背面，因此顺手把材质转 DoubleSide，避免从轮拱看穿车身内部。
 * 原始索引存在 userData 里，可随时 restoreOriginalWheels() 还原。
 *
 * @returns {{removed:number, meshes:number, cylinders:number, drift:Array}}
 */
function cutOriginalWheels({ radiusScale = 1.2, widthPad = 0.08, autoAlign = true } = {}) {
  if (!carGroup) return { removed: 0, meshes: 0, cylinders: 0, drift: [] };

  const seeds = wheelCylinders({ radiusScale, widthPad });
  if (!seeds.length) return { removed: 0, meshes: 0, cylinders: 0 };

  // 先用几何把圆柱对准真实车轮（blindSeed 时跳过，便于对比调试）
  const { cylinders: cyls, drift } = autoAlign
    ? refineCylindersToGeometry(seeds)
    : { cylinders: seeds, drift: [] };

  carOuter.updateMatrixWorld(true);

  const wp = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  let removed = 0;
  let touched = 0;

  // 未拆解的整车 + 拆解装配体都要切：当前显示的是哪套，切口就必须在哪套上
  const meshes = [];
  for (const root of bodyRoots()) {
    root.traverse((o) => {
      if (o.isMesh && o.geometry) meshes.push(o);
    });
  }

  for (const o of meshes) {
    const g = o.geometry;
    const pos = g.attributes?.position;
    if (!pos) return;

    const index = g.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    if (!triCount) return;

    // 首次切除时备份索引，供"恢复"使用（此时几何已是切壳后的状态）
    if (o.userData._origIndex === undefined) {
      o.userData._origIndex = index ? index.array.slice() : null;
    }

    const keep = [];
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      centroid.set(0, 0, 0);
      for (const vi of [ia, ib, ic]) {
        wp.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        centroid.add(wp);
      }
      centroid.multiplyScalar(1 / 3);

      if (cyls.some((cyl) => inCylinder(centroid, cyl))) {
        removed += 1;
        continue;
      }
      keep.push(ia, ib, ic);
    }

    if (keep.length !== triCount * 3) {
      g.setIndex(keep);
      g.computeBoundingSphere();
      // 切口无封盖，转双面避免从轮拱看穿
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.side = THREE.DoubleSide;
      touched += 1;
    }
  }

  return { removed, meshes: touched, cylinders: cyls.length, drift, autoAlign };
}

/** 还原被切掉的原车轮（把备份的索引写回去） */
function restoreOriginalWheels() {
  if (!carGroup) return { restored: 0 };
  let restored = 0;
  for (const root of bodyRoots()) {
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (o.userData._origIndex === undefined) return;
      const g = o.geometry;
      if (o.userData._origIndex) g.setIndex(Array.from(o.userData._origIndex));
      else g.setIndex(null);
      delete o.userData._origIndex;
      g.computeBoundingSphere();
      restored += 1;
    });
  }
  return { restored };
}

/**
 * 从 BANG 拆出来的车轮质心反推真实轮位（轴距 / 前后轮距 / 轮心高）。
 *
 * 坐标约定与整车归一后一致：+X = 车头，±Z = 左右，+Y = 上。
 * 用「按 x 的中位切分 + 组内 z 极差」而不是固定取 4 个，
 * 这样即使拆解更碎（一只轮被拆成轮辋 + 轮胎多件）也能算出合理值。
 *
 * @param {THREE.Vector3[]} centers 世界坐标下的车轮质心
 * @returns {{wheelbase:number, xFront:number, xRear:number, trackFront:number,
 *            trackRear:number, hubY:number, hubYFront:number, hubYRear:number}|null}
 */
/** 3 个车轮时，按左右对称估出第 4 个轮位（常见：BANG 把一只轮跟车身粘在一起没分离） */
function estimateFourthWheel(cs, tol = 0.05) {
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i];
    const hasPartner = cs.some(
      (b, j) =>
        j !== i &&
        Math.abs(b.x - a.x) < tol &&
        Math.abs(b.y - a.y) < tol &&
        Math.abs(b.z + a.z) < tol
    );
    if (!hasPartner) return new THREE.Vector3(a.x, a.y, -a.z);
  }
  return null;
}

function deriveWheelGeometry(centers) {
  let cs = (centers || []).filter((c) => c && Number.isFinite(c?.x) && Number.isFinite(c?.z));
  if (cs.length < 2) return null;

  // 3 轮 fallback：用左右对称补一个，让轮位校准尽量继续
  if (cs.length === 3) {
    const est = estimateFourthWheel(cs);
    if (est) {
      console.log('[bang] 检测到 3 个车轮，按对称估算第 4 个：', est);
      cs = [...cs, est];
    }
  }

  if (cs.length < 4) return null;
  const xs = cs.map((c) => c.x);
  const mid = (Math.max(...xs) + Math.min(...xs)) / 2;
  const front = cs.filter((c) => c.x > mid);
  const rear = cs.filter((c) => c.x <= mid);
  if (front.length < 2 || rear.length < 2) return null;
  const mean = (arr, k) => arr.reduce((a, c) => a + c[k], 0) / arr.length;
  const extent = (arr) => Math.max(...arr.map((c) => c.z)) - Math.min(...arr.map((c) => c.z));
  // 前后轴的**绝对 x 坐标**。这一步是"轮毂精确落进轮拱"的关键：
  // 真实车前后悬不等长，轴距中心 ≠ 车身包围盒中心，只把 wheelbase 传下去、
  // 下游再用 ±wheelbase/2 摆位，会整体偏一个常量（样本实测 11 / 41 / 98 mm）。
  // 坐标系与归一后的整车一致（车长中心 x=0、车头 +X、贴地 y=0），可直接用。
  const xFront = mean(front, 'x');
  const xRear = mean(rear, 'x');
  const wheelbase = Math.abs(xFront - xRear);
  const trackFront = extent(front);
  const trackRear = extent(rear);
  const hubY = mean(cs, 'y');
  // 分轴轮心高：前后轮尺寸不同时（常见的前窄后宽）各自用各自的值
  const hubYFront = mean(front, 'y');
  const hubYRear = mean(rear, 'y');
  // 合理区间兜底：超出范围说明识别出的不是车轮，宁可不校准也不把轮毂摆飞
  if (!(wheelbase > 1.2 && wheelbase < 6)) return null;
  if (!(trackFront > 0.6 && trackFront < 3)) return null;
  if (!(trackRear > 0.6 && trackRear < 3)) return null;
  if (!(hubY > 0.15 && hubY < 0.8)) return null;
  // 轴必须一前一后、且落在车身长度范围内，否则退回不校准
  if (!(xFront > 0 && xRear < 0 && xFront > xRear)) return null;
  return { wheelbase, xFront, xRear, trackFront, trackRear, hubY, hubYFront, hubYRear };
}

/**
 * 判断一个模型是不是「盘状」（轮毂的形状特征）。
 *
 * 只看形状、不看绝对尺度——图生 3D 出来的轮毂尺寸本来就不统一，
 * 但形状一定满足：两个大边近似相等（正圆截面）+ 第三个边明显更短（盘）。
 *
 * @param {THREE.Vector3|{x:number,y:number,z:number}} size 归一后的三边（米）
 * @returns {{ok:boolean, roundness:number, thin:number, d1:number, d2:number, d3:number}}
 */
function wheelShapeOf(size) {
  const d = [Number(size?.x) || 0, Number(size?.y) || 0, Number(size?.z) || 0].sort((a, b) => b - a);
  const [d1, d2, d3] = d;
  const roundness = d1 > 0 ? d2 / d1 : 0;
  const thin = d1 > 0 ? d3 / d1 : 1;
  return {
    ok: roundness > 0.75 && thin >= 0.1 && thin <= 0.55,
    roundness,
    thin,
    d1,
    d2,
    d3,
  };
}

/**
 * 由目标轮胎外半径反推扁平比，让轮毂直径与原车轮一致。
 *
 * 轮心高 = 轮胎外半径（车轮贴地），所以拿实测轮心高当目标半径，
 * 解出合适的扁平比： sidewall = R − 轮辋半径，aspect = sidewall / 胎宽 × 100。
 * 越界（<25 或 >80）返回 null，宁可保持用户当前设定也不塞不合理的值。
 *
 * @param {{rimInch:number, tireWidthMm:number}} wheel 该轴参数
 * @param {number} R 目标轮胎外半径（米）
 * @returns {number|null}
 */
function fitTireAspect(wheel, R) {
  if (!wheel || !(R > 0.2 && R < 0.6)) return null;
  const rimR = ((wheel.rimInch || 19) * 25.4) / 2 / 1000;
  const sidewall = R - rimR;
  if (!(sidewall > 0.03)) return null;
  const aspect = Math.round((sidewall / ((wheel.tireWidthMm || 255) / 1000)) * 100);
  return aspect >= 25 && aspect <= 80 ? aspect : null;
}

/** 当前整车长度（取水平方向最长边），供部件分类做尺度参照 */
function carLengthRef() {
  if (!carGroup) return 0;
  const box = boxOf(carOuter);
  if (box.isEmpty()) return 0;
  const s = box.getSize(new THREE.Vector3());
  return Math.max(s.x, s.z);
}

/**
 * 判断一个部件是不是车轮，纯几何启发式。
 *
 * 车轮的三个特征（缺一不可）：
 *   - 圆度高：横截面接近正圆（d2/d1 → 1），车身/玻璃是长扁的
 *   - 盘状：厚度明显小于直径（厚径比 0.15~0.55），太薄是刹车盘/贴片，太厚是车身
 *   - 尺度对：直径约为车长的 10%~45%，排除过小碎片与过大的车身
 *
 * @returns {{kind:'wheel'|'other', score:number, size:number[], roundness:number, thin:number, rel:number}}
 */
function classifyPart(group, carLength = 0) {
  group.updateMatrixWorld(true);
  const box = boxOf(group);
  if (box.isEmpty()) {
    return { kind: 'other', score: 0, size: [0, 0, 0], roundness: 0, thin: 1, rel: 0 };
  }
  const s = box.getSize(new THREE.Vector3());
  // 判定规则集中在 core/partClassify.js（纯函数，可用真实量测数据单测）
  const r = classifyDims([s.x, s.y, s.z], carLength);
  return { ...r, size: [s.x, s.y, s.z] };
}


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
  // 防御：进度事件只「刷新」已经打开的加载遮罩（整车/轮毂显式加载时），
  // 不允许单独把遮罩拉起——否则后台预览加载会把界面永久卡在「加载模型 100%」。
  if (!overlay.classList.contains('show')) return;
  const pct = Math.min(100, Math.max(0, Number(e.detail.pct) || 0));
  overlayText.textContent = `加载模型 ${pct}%`;

  // 进度越高，logo 旋转/跳跃越快，让用户感知「加载正在冲刺」
  if (overlayIcon) {
    const ratio = pct / 100;
    // 0% -> 2.8s / 100% -> 0.42s
    const spinDur = Math.max(0.42, 2.8 * (1 - ratio * 0.85));
    // 0% -> 1.0s / 100% -> 0.18s
    const bounceDur = Math.max(0.18, 1.0 * (1 - ratio * 0.82));
    overlayIcon.style.setProperty('--jg-spin-dur', `${spinDur.toFixed(3)}s`);
    overlayIcon.style.setProperty('--jg-bounce-dur', `${bounceDur.toFixed(3)}s`);
  }
});

/* ---------------------------- 品牌标识 ---------------------------- */

// 两处：3D 视口右下角水印 / 加载遮罩居中。
// 侧栏顶部品牌板块按需求已移除，不再挂载。
const brands = mountBrandAll({ stage, overlay });
const overlayIcon = brands.overlay?.querySelector('.jg-brand__icon');

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
   * 悬挂高度应用：车身相对车轮升降，车轮始终贴地不动。
   *
   * 输入：
   *   - params.suspensionDelta：全局悬挂降低 Δ（mm），>0 降低车身（旧 slider，与分角叠加）
   *   - params.suspension.{FL,FR,RL,RR}：分角/分轴车身高度偏移（mm），正值升高
   *
   * 输出：
   *   - carInner 整体平移 = base + shellLift − Δ + avg(suspension)
   *   - carInner 俯仰/侧倾由前后/左右高度差自然产生
   *   - chassis.root 跟随平均高度（若用户把它显示出来）
   *   - WheelRig 完全不动，轮胎接地点保持 y=0
   */
  applySuspension() {
    const s = this.params.suspension || { FL: 0, FR: 0, RL: 0, RR: 0 };
    const deltaM = (this.params.suspensionDelta || 0) / 1000;
    const avgSuspMm = (s.FL + s.FR + s.RL + s.RR) / 4;
    const avgSuspM = avgSuspMm / 1000;

    // 轴距 / 轮距：优先用车型数据，否则用底盘推导值
    const wbM = (this.params.wheelbase ? this.params.wheelbase / 1000 : null)
      || this.chassis?.p?.wheelbase
      || 2.6;
    const trackFrontM = (this.params.trackFront ? this.params.trackFront / 1000 : null)
      || (this.chassis?.p?.halfTrack_F || 0.8) * 2
      || 1.6;
    const trackRearM = (this.params.trackRear ? this.params.trackRear / 1000 : null)
      || (this.chassis?.p?.halfTrack_R || 0.8) * 2
      || 1.6;
    const trackAvgM = (trackFrontM + trackRearM) / 2;

    // 前后平均差 → 俯仰（绕 Z 轴），左右平均差 → 侧倾（绕 X 轴）
    const frontAvg = (s.FL + s.FR) / 2;
    const rearAvg = (s.RL + s.RR) / 2;
    const leftAvg = (s.FL + s.RL) / 2;
    const rightAvg = (s.FR + s.RR) / 2;
    const pitchRad = ((rearAvg - frontAvg) / 1000) / Math.max(0.5, wbM);
    const rollRad = ((rightAvg - leftAvg) / 1000) / Math.max(0.5, trackAvgM);

    const lift = this.chassis?.p?.shellLift ?? 0;
    const base = this._baseShellY ?? carInner.position.y;

    carInner.position.y = base + lift - deltaM + avgSuspM;
    carInner.rotation.x = rollRad;
    carInner.rotation.z = pitchRad;

    // 底盘几何跟随平均车身高度（用户想隐藏，但万一打开也要对齐）
    this.chassis.setSuspension(this.params.suspensionDelta || 0, avgSuspMm);

    const changed =
      Math.abs(deltaM - (this._lastDeltaM ?? NaN)) >= 1e-6 ||
      Math.abs(avgSuspM - (this._lastAvgSuspM ?? NaN)) >= 1e-6 ||
      Math.abs(pitchRad - (this._lastPitchRad ?? NaN)) >= 1e-6 ||
      Math.abs(rollRad - (this._lastRollRad ?? NaN)) >= 1e-6;

    this._lastDeltaM = deltaM;
    this._lastAvgSuspM = avgSuspM;
    this._lastPitchRad = pitchRad;
    this._lastRollRad = rollRad;

    if (!changed) return;
    carOuter.updateMatrixWorld(true);
    // 车身位姿变化 → 切割世界坐标缓存必须重算
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
  /**
   * 把查到的真车参数落到建模上：车长/车宽/车高直接用于归一，
   * 轴距与轮距交给四轮 rig，让轮位也是真的。
   *
   * @param {Object|null} s /api/specs 的返回（available 为真才生效）
   * @returns {boolean} 是否应用成功
   */
  applyRealSpecs(s) {
    if (!s?.available || !s.length) return false;
    this.params.realSpecs = {
      length: s.length,
      width: s.width ?? null,
      height: s.height ?? null,
      wheelbase: s.wheelbase ?? null,
      trackFront: s.trackFront ?? null,
      trackRear: s.trackRear ?? null,
      groundClearance: s.groundClearance ?? null,
      approachAngle: s.approachAngle ?? null,
      departureAngle: s.departureAngle ?? null,
      rimInch: s.rimInch ?? null,
      tireWidth: s.tireWidth ?? null,
      aspect: s.aspect ?? null,
      source: s.source || '',
      confidence: s.confidence ?? 0,
    };
    // 车长（毫米 → 米）作为归一锚点
    this.params.carLength = s.length / 1000;
    // 其余真车尺寸落到 params，供「车型数据」面板直接展示与微调
    this.params.carWidth = s.width ? s.width / 1000 : null;
    this.params.carHeight = s.height ? s.height / 1000 : null;
    this.params.wheelbase = s.wheelbase ?? null;
    this.params.trackFront = s.trackFront ?? null;
    this.params.trackRear = s.trackRear ?? null;
    this.params.groundClearance = s.groundClearance ?? null;
    this.params.approachAngle = s.approachAngle ?? null;
    this.params.departureAngle = s.departureAngle ?? null;

    /* 已有 BANG 实测轴位置时，轴距以实测为准 —— 实测值是从**当前这台模型**上
     * 量出来的，比车型库数据更贴合几何；同时用实测轴距反算 wheelbase，
     * 保证「轴距 = 前轴 x − 后轴 x」三者一致（混搭会让下游算出矛盾的四角）。 */
    if (Number.isFinite(this.params.axleXFront) && Number.isFinite(this.params.axleXRear)) {
      this.params.wheelbase = Math.round(this.params.axleXFront - this.params.axleXRear);
    }

    // 轴距 / 轮距：交给 rig 当轮位规格，优先于按车身尺寸估算
    if (this.params.wheelbase && s.trackFront && s.trackRear) {
      rig.setRealGeometry({
        wheelbase: this.params.wheelbase / 1000,
        trackFront: s.trackFront / 1000,
        trackRear: s.trackRear / 1000,
      });
    }

    /* 原厂轮毂/轮胎规格：把 OEM 数据种进轮胎滑杆，让"数据真"贯彻到底——
     * 后续所有调参（ET/J/倾角/轮距）都从真车原厂胎开始，而不是 SL 350 默认。
     * 仅当三项齐全才覆盖，缺任一字段就保留用户/默认设定，避免半截数据误导。
     * J 值/ET/倾角属"改装取向"而非原厂公开参数，留作手动调参，不强行填。 */
    if (s.rimInch && s.tireWidth && s.aspect) {
      const seed = { rimInch: s.rimInch, tireWidthMm: s.tireWidth, aspect: s.aspect };
      Object.assign(this.params.front, seed);
      Object.assign(this.params.rear, seed);
    }
    return true;
  },

  refitCar({ recapture = true } = {}) {
    if (!carGroup) return;
    // ② 摆正 + 归一
    carInner.position.set(0, 0, 0);
    carInner.quaternion.identity();
    carInner.scale.set(1, 1, 1);
    // 有真车数据时按真实长宽高归一（否则只锁车长，保持纯等比）
    normalizeCar(carInner, {
      targetLength: this.params.carLength,
      targetWidth: this.params.carWidth,
      targetHeight: this.params.carHeight,
      groundY: 0,
    });
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

    // ⑤ 推导底盘参数（车型识别数据优先于经验比例）
    this.chassis.p.shellLiftUser = this.params.chassis.shellLiftUser / 1000;
    const p = this.params;
    this.chassis.derive(metrics, { front: this.params.front, rear: this.params.rear }, {
      wheelbase: p.wheelbase ? p.wheelbase / 1000 : null,
      // 实测前后轴的绝对 x 坐标（米）。给了就采信，不给才退回 ±wheelbase/2。
      axleX_F: Number.isFinite(p.axleXFront) ? p.axleXFront / 1000 : null,
      axleX_R: Number.isFinite(p.axleXRear) ? p.axleXRear / 1000 : null,
      // ChassisParams 内部把 halfTrack_F/R 当半轮距直接用，因此传 track / 2000
      halfTrack_F: p.trackFront ? p.trackFront / 2000 : null,
      halfTrack_R: p.trackRear ? p.trackRear / 2000 : null,
      rideHeight: p.groundClearance ? p.groundClearance / 1000 : null,
    });
    /* 同步用真实轴距 / 轮距 / 轴位置覆盖四轮位置
     * （支持部分更新：只调 wheelbase 或只调轮距也会生效）。
     * axleXFront / axleXRear 必须一起传：wheelRig 里 realGeometry 会盖掉
     * chassis.cornerSpec 的 x，只修 chassis 不修这里等于白修。 */
    // 没有实测轴位置时显式清掉：它是绝对坐标，换车后留着上一辆车的值会把轮毂摆飞
    if (!(Number.isFinite(p.axleXFront) && Number.isFinite(p.axleXRear))) {
      rig.clearAxlePositions();
    }
    rig.setRealGeometry({
      wheelbase: p.wheelbase ? p.wheelbase / 1000 : null,
      trackFront: p.trackFront ? p.trackFront / 1000 : null,
      trackRear: p.trackRear ? p.trackRear / 1000 : null,
      axleXFront: Number.isFinite(p.axleXFront) ? p.axleXFront / 1000 : null,
      axleXRear: Number.isFinite(p.axleXRear) ? p.axleXRear / 1000 : null,
    });
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

  /* ---- 车漆改色 ---- */

  /**
   * 收集车身材质：只遍历 carGroup 子树（车身 GLB 根），
   * 排除 chassis.root（卡钳/底盘）与 rig.root（轮胎/轮毂），天然零污染。
   * 同时缓存每个材质的原 baseColor 贴图，供「纯色重喷 ↔ 着色叠加」切换还原。
   */
  collectBodyMaterials() {
    this.bodyMaterials = [];
    this._bodyMaps = [];
    // 未拆解的整车 + 拆解装配体：谁在场景里显示就给谁上色
    for (const root of bodyRoots()) {
      root.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && m.isMeshPhysicalMaterial) {
            this.bodyMaterials.push(m);
            this._bodyMaps.push(m.map || null);
          }
        }
      });
    }
  },

  /**
   * 改车漆色：仅作用于已收集的车身材质。
   * @param {string} hex  如 '#c8102e'
   * @param {boolean} solid true=纯色重喷（去掉 baseColor 贴图）；false=着色叠加（保留贴图）
   */
  setBodyColor(hex, solid = this.params.bodySolid) {
    if (!this.bodyMaterials || !this.bodyMaterials.length) return;
    const c = new THREE.Color(hex);
    const useSolid = !!solid;
    this.bodyMaterials.forEach((m, i) => {
      m.color.copy(c);
      m.map = useSolid ? null : this._bodyMaps[i] || null;
      m.needsUpdate = true;
    });
    this.params.bodyColor = hex;
    this.params.bodySolid = useSolid;
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
      // 加载新车前清理上一轮 BANG 拆解产物，避免“整车 + 拆解车身”双车叠加
      clearBangParts();
      // 同时清掉上一轮轮毂模板，防止旧车的异常轮毂遗留到新车上
      resetWheelToProcedural();
      carGroup = group;
      carInner.add(carGroup);
      // 车身材质收集 + 按当前方案色值上色（着色/纯色随 params）
      this.collectBodyMaterials();
      this.setBodyColor(this.params.bodyColor, this.params.bodySolid);

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
  /**
   * 切换到预设轮毂款式。所有预设均配置真实 GLB 轮毂模型；加载失败时
   * 才退回程序生成作为兜底，保证预览不中断。
   * 会保留当前 ET/J/倾角/尺寸等全部调节参数。
   */
  async loadPresetWheel(style = 'default') {
    const preset = RIM_PRESETS.find((p) => p.style === style) || RIM_PRESETS[0];
    this.params.rimPreset = style;
    this.params.customWheelUrl = null; // 切回预设款式，不再使用自定义生成轮毂

    if (preset.glbUrl) {
      const r = await this.loadWheelFromUrl(preset.glbUrl);
      // loadWheelFromUrl 失败或形状被拒时会自动回退程序化轮毂；这里只额外同步 UI
      if (!r || r.rejected) {
        console.warn(`[preset wheel] ${preset.label} 真实模型加载失败，已回退程序生成`);
      }
      panel?.syncAll();
      return;
    }

    // 无真实 GLB 的款式：回退程序生成
    rig.useProceduralWheel(style);
    this.apply();
    panel?.syncAll();
  },

  async loadWheelFromUrl(url) {
    showOverlay('正在载入轮毂模型…');
    try {
      const { group } = await loadGLB(url);
      const measured = normalizeWheel(group);
      /* 形状校验：图生 3D 拿轮毂照片有时会重建出整车/带车身的一大块
       * （实测一次产物是 1.81×1.16×1.90m，明显是车不是轮）。
       * 这种模板装到四轮上会被 rig 缩成"四个小车"，比没有还糟。
       * 判据只看形状不看绝对尺寸：盘状 = 两个大边接近相等 + 厚度明显更小。 */
      const shape = wheelShapeOf(measured.size);
      if (!shape.ok) {
        console.warn(
          `[wheel] 生成的不是盘状轮毂（${shape.d1.toFixed(2)}×${shape.d2.toFixed(2)}×${shape.d3.toFixed(2)}m，` +
            `圆度 ${shape.roundness.toFixed(2)} 厚径比 ${shape.thin.toFixed(2)}），已保留程序化轮毂`
        );
        disposeObject(group);
        if (wheelGroup) disposeObject(wheelGroup);
        wheelGroup = null;
        rig.useProceduralWheel(this.params.rimPreset);
        this.apply();
        panel?.syncAll();
        hideOverlay();
        return { ...measured, rejected: true, shape };
      }
      if (wheelGroup) disposeObject(wheelGroup);
      wheelGroup = group;
      rig.setWheelSource(group, measured);
      this.apply();
      panel?.syncAll();
      hideOverlay();
      return { ...measured, rejected: false, shape };
    } catch (e) {
      console.warn('[wheel] 载入失败，回退程序化轮毂：', e.message);
      rig.useProceduralWheel(this.params.rimPreset);
      this.apply();
      panel?.syncAll();
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
    const sig = sigOfFiles(files);
    // 额度用尽后，再次上传同一张照片必然继续吃 429——直接提示，不再打云端浪费次数
    if (
      this._wheelQuotaExceeded &&
      sig &&
      sig === this._wheelLastSig &&
      this._wheelQuotaDate === todayYMD()
    ) {
      handleGenerateError(
        'wheel',
        new GenerateError('今日 hy-3d 额度已用完，重新上传同一张照片不会成功', {
          reason: 'quota',
          detail: '今日 5/5 次提交额度已用尽，预计今天 00:00 后重置，到时再重试',
          images: null,
        })
      );
      return;
    }
    this._wheelPendingSig = sig;
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
    this.setBodyColor(this.params.bodyColor, this.params.bodySolid);
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

  /* ---- BANG 拆解（Hyper3D） ---- */

  /**
   * 把当前车模交给 Hyper3D BANG 拆成多个部件（车身 / 轮毂 / 玻璃…）。
   * 产物挂在独立的 bangRoot 下，不动 carGroup / 轮胎 rig，避免破坏现有装配。
   *
   * @param {Object=} opts
   * @param {number=} opts.strength  拆解力度 2–12，越大拆得越碎
   * @param {string=} opts.resolution 贴图分辨率 Basic(2K) / High(4K)
   * @param {string=} opts.material   PBR / Shaded / All / None
   * @returns {Promise<{count:number, parts:Array}|null>}
   */
  async bangCurrentCar({ strength = 5, resolution = 'Basic', material = 'None' } = {}) {
    const src = currentPlan?.carModelUrl || '/models/my-car.glb';
    showOverlay('正在提交 BANG 拆解…');
    try {
      clearBangParts();
      const result = await bangModel({
        modelUrl: src,
        strength,
        resolution,
        material,
        onProgress: (p) => {
          if (p?.message) showOverlay(p.message);
        },
      });

      const parts = Array.isArray(result?.parts) ? result.parts : [];
      if (!parts.length) throw new Error('云端未返回任何部件');

      const count = await this.applyBangParts(parts);
      if (!count) throw new Error('所有部件均载入失败');
      hideOverlay();
      return { count, parts };
    } catch (e) {
      console.error('[bang]', e);
      hideOverlay();
      alert(`BANG 拆解失败：${e.message}`);
      return null;
    }
  },

  /**
   * 挂载 BANG 拆解产物。
   *
   * 为什么不是"摆到车旁边"：
   *   实测 Hyper3D BANG 一次返回的是**一个 GLB 文件、内含多个子网格**
   *   （车身 1 + 四轮 4），坐标与原始整车完全一致。整文件摆到车边就变成
   *   「整车 + 一整台复制品」的双车 BUG；而完全不摆，用户就只能看到
   *   未拆解的整车。
   *
   * 正确做法（本函数默认 `assemble` 模式）：
   *   ① 把文件里的每个子网格拆成独立可移动部件（烘焙世界变换）
   *   ② 挂进 carInner，与 carGroup 共享归一变换 → 部件精确落在整车原位
   *   ③ 隐藏未拆解的整车 → 场景里是"一辆由可拆部件组成的完整车"
   *   ④ 只保留车身部件；车轮的**位置**反推成轴距/轮距交给四轮 rig，
   *      生成的轮毂因此精确落在原车轮的位置上（车轮网格本身不入场景）
   *
   * @param {Array<{name:string,url:string,index:number}>} parts
   * @param {{mode?:'assemble'|'spread', offsetX?:number}=} opts
   * @returns {Promise<{total:number, body:number, wheel:number, geom:Object|null}>}
   */
  async applyBangParts(parts, { mode = 'assemble', offsetX = 3 } = {}) {
    const empty = { total: 0, body: 0, wheel: 0 };
    if (!Array.isArray(parts) || !parts.length) return empty;
    clearBangParts();

    const loaded = [];
    for (const p of parts) {
      try {
        const { group } = await loadGLB(p.url);
        for (const m of splitBangFile(group)) loaded.push(m);
      } catch (e) {
        console.warn('[bang] 部件载入失败，已跳过：', p?.name, e.message);
      }
    }
    if (!loaded.length) return empty;

    // 手动导入的散件：彼此坐标系无关，仍按一字排开摆在车旁
    if (mode === 'spread') {
      layoutBangParts(loaded, { offsetX });
      bangMountedSig = parts.map((p) => p?.url).join('|');
      return { total: loaded.length, body: loaded.length, wheel: 0 };
    }

    for (const m of loaded) {
      m.position.set(0, 0, 0);
      bangAssembly.add(m);
    }
    carOuter.updateMatrixWorld(true);
    fitBangAssemblyToCar();
    carOuter.updateMatrixWorld(true);

    // 分类：车轮 vs 车身部件
    const carLen = carLengthRef();
    const body = [];
    const wheel = [];
    for (const m of [...bangAssembly.children]) {
      const info = classifyPart(m, carLen);
      (info.kind === 'wheel' ? wheel : body).push(m);
    }

    /* 用拆出来的四个车轮反推**真实轮位**（轴距 / 轮距 / 轮心高）。
     * 这一步是"轮毂摆到车轮对应位置"的关键：rig 默认按车身包围盒比例估算轮位，
     * 实测与模型真实车轮差 170mm 量级，轮毂会偏离轮拱甚至插进车身。
     * 这里直接拿 BANG 分离出的车轮质心当真值，轮毂就落在原车轮的位置上。 */
    const geom = deriveWheelGeometry(
      wheel.map((m) => boxOf(m).getCenter(new THREE.Vector3()))
    );

    // 只要拆开的车身：车轮部件不入场景，位置信息交给 rig 后即释放
    for (const m of wheel) {
      bangAssembly.remove(m);
      disposeBangPart(m);
    }

    // 爆炸方向：装配体局部空间中，从整体中心指向部件中心
    const boxL = new THREE.Box3();
    for (const m of [...bangAssembly.children]) {
      if (m.geometry.boundingBox) boxL.union(m.geometry.boundingBox);
    }
    const center = boxL.isEmpty() ? new THREE.Vector3() : boxL.getCenter(new THREE.Vector3());
    this._bangSpan = boxL.isEmpty() ? 1 : boxL.getSize(new THREE.Vector3()).length();
    this._bangParts = [];
    this._bangWheelParts = [];
    for (const m of [...bangAssembly.children]) {
      const c = m.geometry.boundingBox
        ? m.geometry.boundingBox.getCenter(new THREE.Vector3())
        : new THREE.Vector3();
      const dir = c.sub(center);
      if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
      dir.normalize();
      this._bangParts.push({ mesh: m, dir });
    }
    if (geom) this.applyBangWheelGeometry(geom);

    // 用实测/估算轮位把 carGroup 上的原车轮也切掉，
    // 这样切回整车单体视图或清除 BANG 后，车身轮拱是干净的，不会残留原车轮胎与新轮毂重叠。
    const cutRes = cutOriginalWheels({ radiusScale: 1.15, widthPad: 0.06 });
    if (cutRes.removed) console.log('[bang] 已同步切除 carGroup 原车轮：', cutRes);

    if (body.length) {
      // 用装配体顶替整车：不隐藏就会两份几何重叠，正是"穿模"的来源
      if (carGroup) carGroup.visible = false;
      /* 关键：拆出来的车身本身就是**水密封闭实体**（实测 0 条边界边），
       * 车轮分离后留下的就是真实轮拱与车底。三道切割（C1 底切 / C2 侧切 / C3 轮拱开口）
       * 是为"车轮画在贴图里、没有几何"的整车载模型设计的，作用在这种车身上
       * 只会把轮拱和车底切穿 → 从轮拱看进去是空壳。所以装配体在场时必须关掉切割。 */
      this.params.shell.enabled = false;
      // 重新接管车壳（关闭切割后仍要重切一次，把之前切掉的索引还原回来）
      this.refitCar({ recapture: true });
      this.collectBodyMaterials();
      this.setBodyColor(this.params.bodyColor, this.params.bodySolid);
    }
    this.setBangExplode(this.params.bangExplode ?? 0);
    bangMountedSig = parts.map((p) => p?.url).join('|');
    return { total: loaded.length, body: body.length, wheel: wheel.length, geom };
  },

  /**
   * 把 BANG 实测出的轮位写进 params，让随后生成的轮毂落在原车轮位置上。
   *
   * 走的是既有链路：refitCar() → chassis.derive({wheelbase, halfTrack}) +
   * rig.setRealGeometry({wheelbase, trackFront, trackRear})，
   * 所以 ET / J / 倾角 / 轮距滑杆仍然照常生效，只是基准位置换成了实测值。
   *
   * @param {{wheelbase:number, trackFront:number, trackRear:number, hubY:number}} g 单位：米
   */
  applyBangWheelGeometry(g) {
    this.params.wheelbase = Math.round(g.wheelbase * 1000);
    this.params.trackFront = Math.round(g.trackFront * 1000);
    this.params.trackRear = Math.round(g.trackRear * 1000);

    /* 实测轴位置（必备）：只写 wheelbase 会让下游按 ±wheelbase/2 对称摆位，
     * 而真实车前后悬不等长 → 两只轴会整体平移同一个常量，轮毂就出不了轮拱。
     * 挂在 params 上，refitCar() 会同时喂给 chassis.derive 与 rig.setRealGeometry。 */
    if (Number.isFinite(g.xFront) && Number.isFinite(g.xRear)) {
      this.params.axleXFront = Math.round(g.xFront * 1000);
      this.params.axleXRear = Math.round(g.xRear * 1000);
    } else {
      this.params.axleXFront = null;
      this.params.axleXRear = null;
    }

    // 轮胎外径也对齐到原车轮：轮心高即外半径，反推扁平比，
    // 否则轮毂会比轮拱小一圈（实测这台车差 24mm，视觉上就是轮子陷进去）
    const aF = fitTireAspect(this.params.front, g.hubYFront ?? g.hubY);
    const aR = fitTireAspect(this.params.rear, g.hubYRear ?? g.hubY);
    if (aF) this.params.front.aspect = aF;
    if (aR) this.params.rear.aspect = aR;

    this.params.bangWheelGeom = { ...g, aspectFront: aF, aspectRear: aR, source: 'bang' };
    console.log(
      `[bang] 轮位按拆解实测校准：轴距 ${this.params.wheelbase}mm` +
        ` / 前轮距 ${this.params.trackFront}mm / 后轮距 ${this.params.trackRear}mm` +
        ` / 轴位置 前 ${this.params.axleXFront ?? '-'} 后 ${this.params.axleXRear ?? '-'} mm` +
        ` / 轮心高 ${(g.hubY * 1000).toFixed(0)}mm` +
        (aF || aR ? ` / 扁平比对齐为 前 ${aF ?? '-'} 后 ${aR ?? '-'}` : '')
    );
  },

  /**
   * 爆炸视图：把各部件沿"背离装配体中心"的方向推开。
   * @param {number} t 0 = 完全装配，1 = 最大散开
   */
  setBangExplode(t) {
    const k = Math.max(0, Math.min(1, Number(t) || 0));
    this.params.bangExplode = k;
    const span = this._bangSpan || 1;
    for (const rec of [...(this._bangParts || []), ...(this._bangWheelParts || [])]) {
      rec.mesh.position.copy(rec.dir).multiplyScalar(k * span * 0.55);
    }
    carOuter.updateMatrixWorld(true);
  },

  /**
   * 整车显示模式切换。
   * @param {'assembled'|'single'} mode
   *   assembled = 拆解装配体（默认，一辆由可拆部件组成的完整车）
   *   single    = 未拆解的整车单体
   */
  setBangView(mode) {
    const hasAssembly = (this._bangParts?.length || 0) > 0;
    const assembled = mode !== 'single' && hasAssembly;
    if (this.params.bangView === (assembled ? 'assembled' : 'single') && bangAssembly.visible === assembled) {
      return;
    }
    this.params.bangView = assembled ? 'assembled' : 'single';
    bangAssembly.visible = assembled;
    if (carGroup) carGroup.visible = !assembled;
    /* 切割策略随视图切换：
     * 拆解车身（封闭实体、自带轮拱）→ 关切割；
     * 整车单体（车轮画在贴图上）→ 开切割，才轮拱开口让轮毂露出来。 */
    const wantCut = !assembled;
    if (this.params.shell.enabled !== wantCut) {
      this.params.shell.enabled = wantCut;
      this.refitCar({ recapture: true });
    }
  },

  /** 拆解状态，供面板显示（含按拆解实测校准出来的轮位） */
  bangInfo() {
    const g = this.params.bangWheelGeom || null;
    return {
      total: this._bangParts?.length || 0,
      body: this._bangParts?.length || 0,
      wheel: 0, // 车轮不入场景，位置信息已转成轮位供轮毂使用
      view: this._bangParts?.length ? this.params.bangView || 'assembled' : 'none',
      geom: g
        ? {
            wheelbase: Math.round(g.wheelbase * 1000),
            trackFront: Math.round(g.trackFront * 1000),
            trackRear: Math.round(g.trackRear * 1000),
            hubY: Math.round(g.hubY * 1000),
            // 实测轴位置（mm，车长中心为 0、车头 +X），用于核对轮毂是否落进轮拱
            axleXFront: Number.isFinite(g.xFront) ? Math.round(g.xFront * 1000) : null,
            axleXRear: Number.isFinite(g.xRear) ? Math.round(g.xRear * 1000) : null,
          }
        : null,
    };
  },

  /** 移除 BANG 拆解产物，恢复整车视图 */
  clearBang() {
    clearBangParts();
  },

  /**
   * 切掉车身上原有的车轮，方便换装新轮毂。
   * @param {{radiusScale?:number, widthPad?:number}=} opts
   *   radiusScale 半径放大系数（默认 1.04，留一点余量避免残留一圈原车轮）
   *   widthPad    轴向额外余量（米，默认 0.015）
   */
  cutOriginalWheels(opts) {
    return cutOriginalWheels(opts);
  },

  /** 还原被切掉的原车轮 */
  restoreOriginalWheels() {
    return restoreOriginalWheels();
  },

  /** 当前是否已切过原车轮，供 UI 显示按钮状态 */
  hasCutOriginalWheels() {
    let cut = false;
    for (const root of bodyRoots()) {
      root.traverse((o) => {
        if (o.isMesh && o.userData._origIndex !== undefined) cut = true;
      });
    }
    return cut;
  },

  /**
   * 导入已经在别处拆好的部件 GLB（Hyper3D 网页版 / Scenario 的 BANG 产物）。
   *
   * 为什么走这条路：BANG 走 API 要 $120/月订阅，走网页版按次付费约 $0.75/台。
   * 所以拆解那一步放到网页端手动做，识别 + 装车的自动化留在本项目侧。
   *
   * 行为：
   *   1. 逐个上传并载入部件
   *   2. 几何识别哪个是车轮 → 直接装到四轮 rig（替换当前轮毂模板）
   *   3. 其余部件摆在整车旁边，方便你核对拆出了什么
   *
   * @param {FileList|File[]} files
   * @returns {Promise<{total:number, wheel:Object|null, items:Array}|null>}
   */
  async importBangParts(files) {
    const list = Array.from(files || []).filter((f) => /\.glb$/i.test(f.name || ''));
    if (!list.length) {
      alert('请选择 .glb 部件文件（BANG 拆解产物）');
      return null;
    }

    const carLen = carLengthRef();
    showOverlay(`正在导入 ${list.length} 个部件…`);
    try {
      const items = [];
      for (let i = 0; i < list.length; i++) {
        showOverlay(`上传部件 ${i + 1}/${list.length}…`);
        const up = await uploadPart(list[i]);
        const { group } = await loadGLB(up.url);
        const info = classifyPart(group, carLen);
        items.push({ url: up.url, name: up.name, group, info });
        console.log(
          `[bang-import] ${up.name} → ${info.kind}` +
            ` 尺寸 ${info.size.map((v) => v.toFixed(3)).join('×')}` +
            ` 圆度 ${info.roundness.toFixed(2)} 厚径比 ${info.thin.toFixed(2)} 相对车长 ${info.rel.toFixed(2)}`
        );
      }

      // 车轮：取评分最高的那个装到四轮
      const wheelItem = items
        .filter((it) => it.info.kind === 'wheel')
        .sort((a, b) => b.info.score - a.info.score)[0];

      let wheel = null;
      if (wheelItem) {
        const measured = normalizeWheel(wheelItem.group);
        if (wheelGroup) disposeObject(wheelGroup);
        wheelGroup = wheelItem.group;
        rig.setWheelSource(wheelItem.group, measured);
        this.apply();
        wheel = measured;
      }

      // 其余部件摆到整车旁边（车轮已交给 rig，不再重复入场景）
      const rest = items.filter((it) => it !== wheelItem).map((it) => it.group);
      clearBangParts();
      if (rest.length) layoutBangParts(rest, { offsetX: 3 });

      hideOverlay();
      return {
        total: items.length,
        wheel,
        items: items.map((it) => ({ name: it.name, url: it.url, kind: it.info.kind })),
      };
    } catch (e) {
      console.error('[bang-import]', e);
      hideOverlay();
      alert(`部件导入失败：${e.message}`);
      return null;
    }
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

/**
 * 载入生成好的模型，并写回一句人话状态。
 *
 * parts：Hyper3D 生成后自动 BANG 拆解出的部件。
 * 这是流水线的一部分——**用户不需要点任何按钮**，生成完就已经拆好并按原坐标
 * 装配回整车（不是摆到旁边的第二辆车，也不是没拆的整车单体）。
 */
async function applyResult(kind, url, parts) {
  const u = uploaderOf(kind);
  if (kind === 'wheel') {
    const m = await app.loadWheelFromUrl(url);
    if (m?.rejected) {
      // 生成成功，但形状不像轮毂（多半是照片里带了整车）→ 说清楚并给出可执行的下一步
      const s = m.shape || {};
      u.setStatus(
        `生成完成，但产出不是轮毂（量得 ${(s.d1 || 0).toFixed(2)}×${(s.d2 || 0).toFixed(2)}×${(s.d3 || 0).toFixed(2)}m，` +
          `厚径比 ${(s.thin || 0).toFixed(2)}，像整车/带车身的一大块），已保留程序化轮毂`,
        'err'
      );
      u.setDetail?.([
        '请改上传**只有轮毂**的特写：正面 + 侧面 + 斜 45°，画面里不要出现车身、翼子板、地面以外的环境。',
        '轮毂已固定走 Hyper3D Rodin；换图重传即可，不需要改任何设置。',
      ]);
      return;
    }
    u.setStatus(
      m
        ? `生成完成，已装配 4 只（量得直径 ${(m.diameter * 1000).toFixed(0)}mm / 宽 ${(m.width * 1000).toFixed(0)}mm）`
        : '生成完成，但模型载入异常，已用程序化轮毂兜底',
      m ? 'ok' : 'err'
    );
    return;
  }
  await app.loadCarFromUrl(url);
  // 写回当前方案：这张整车模型就是用户提交的车型，预览卡片要显示它而非默认 SL 350
  if (currentPlan) {
    currentPlan.carModelUrl = url;
    if (Array.isArray(parts)) currentPlan.bangParts = parts;
    /* 立刻落盘。拆解产物原本只在内存里，用户不点「返回车库」就刷新页面会丢失，
     * 再进来就只剩未拆解的整车（正是"车身不是实体、轮拱是空的"的成因）。 */
    try {
      garage?.upsertPlan?.({ ...currentPlan, updatedAt: Date.now() });
    } catch (e) {
      console.warn('[plan] 即时保存方案失败：', e.message);
    }
  }

  // 新生成的整车必须保持原始车漆贴图，不套用方案里可能残留的旧色值
  app.params.bodyColor = '#ffffff';
  app.params.bodySolid = false;
  app.setBodyColor('#ffffff', false);
  panel?.syncColor?.();

  // 拆解产物按原坐标装配回整车原位：得到"一辆由可拆部件组成的完整车身"，
  // 同时用分离出来的车轮反推真实轮位，让生成的轮毂精确落在车轮位置上
  let bangNote = '';
  if (Array.isArray(parts) && parts.length) {
    const r = await app.applyBangParts(parts);
    if (r.body) bangNote += `，车身已拆解为 ${r.body} 个独立部件并装配回原位`;
    if (r.geom) {
      bangNote += `，轮位已按拆解实测校准（轴距 ${Math.round(r.geom.wheelbase * 1000)}mm / 前轮距 ${Math.round(r.geom.trackFront * 1000)}mm / 后轮距 ${Math.round(r.geom.trackRear * 1000)}mm）`;
    }
    // 扁平比被对齐过，滑杆要跟着刷新
    panel?.syncAll?.();
  }
  u.setStatus('生成完成，已装载你的车' + bangNote, 'ok');
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

  /* 全新上传：整车先做视觉识别（车型 + 真车参数），轮毂**不做**。
   * 轮毂照片识别不出车型，跑一次视觉接口纯属浪费时间与额度，
   * 用户也明确要求取消——所以这里按 kind 分流，轮毂直接进入生成。 */
  if (files && kind === 'wheel') {
    u.setThumbs(files);
    u.clearRecovery();
    u.setProgress(0.01);
    u.setStatus('开始生成轮毂…');
  } else if (files) {
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

      /* 识别到车型后，顺手把真车参数拉回来。
       * 拿到就按真实长宽高建模、按真实轴距/轮距定位四轮——
       * 后续所有调节（ET/J/倾角/轮距/悬挂）都建立在真车尺度上。
       * 查询失败不影响生成，退回默认车长即可。 */
      if (kind === 'car') {
        u.setRecog(`已识别：${rec.fullName}（把握 ${pct}%）· 正在查真车参数…`, 'ok');
        const sp = await fetchCarSpecs(rec.fullName, rec.year).catch(() => null);
        if (sp?.available && app.applyRealSpecs(sp)) {
          const rs = app.params.realSpecs;
          // 把识别到的车型名带进 realSpecs，供右上角车身数据面板展示
          rs.fullName = rec.fullName || rs.query || '';
          rs.query = rec.fullName || rs.query || '';
          u.setRecog(
            `已识别：${rec.fullName}（把握 ${pct}%）· 真车参数已应用`,
            'ok'
          );
          u.setDetail?.(
            `真车 ${rs.length}×${rs.width || '?'}×${rs.height || '?'}mm，轴距 ${rs.wheelbase || '?'}mm` +
              `，前/后轮距 ${rs.trackFront || '?'}/${rs.trackRear || '?'}mm` +
              `，离地 ${rs.groundClearance || '?'}mm` +
              `，接近/离去角 ${rs.approachAngle || '?'}/${rs.departureAngle || '?'}°（来源：${rs.source}）`
          );
          console.log('[specs] 应用真车参数', rs);
          // 真车 OEM 轮毂/轮胎已种入 params.front/rear，刷新滑杆让 UI 立刻反映真车数据，
          // 而不是停留在 SL 350 默认；后续所有调参都从真车原厂胎起步。
          panel?.syncAll();
        } else {
          u.setRecog(
            `已识别：${rec.fullName}（把握 ${pct}%）· 未查到真车参数，按默认比例`,
            'warn'
          );
        }
      }
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
      // 轮毂固定走 Hyper3D Rodin：与整车同一家，轮辋/辐条几何与螺栓孔位更准。
      engine: kind === 'wheel' ? app.params.wheelEngine || 'hyper3d' : app.params.engine,
      falHighPack: app.params.falHighPack,
      onProgress: (s) => {
        u.setProgress(s.progress);
        u.setStatus(s.message);
        // Hyper3D 提示词规则：后端回传 ①完整英文 prompt ②业务执行说明，就地展示
        if (s.stage === 'prompt' && s.prompt) {
          u.setDetail?.([s.taskNote || '', `Hyper3D prompt：${s.prompt}`]);
        }
      },
    });

    if (res.mode === 'demo') {
      // 后端处于 DEMO 模式，返回的是预置模型，必须说清楚不是用户的车
      await (kind === 'wheel' ? app.loadWheelFromUrl(res.url) : app.loadCarFromUrl(res.url));
      u.setStatus(`已载入${meta.label}演示模型（不是你上传的照片生成的，未消耗额度）`, 'warn');
      u.setDetail('配置凭证后重新上传，才会真实生成你的车。');
    } else {
      // res.parts：后端生成后自动 BANG 拆解的结果（没有则为 null）
      await applyResult(kind, res.url, res.parts);
      // 真实生成成功 ⇒ 说明额度未耗尽（或已恢复），解除去重拦截
      if (kind === 'wheel' && res.mode === 'live') {
        app._wheelQuotaExceeded = false;
        app._wheelLastSig = '';
        // 记录到「我的轮毂」库，清空上传区，方便继续生成下一只
        app.params.customWheelUrl = res.url;
        app.params.rimPreset = 'custom';
        await recordGeneratedWheel({ url: res.url, files, name: title || '我的轮毂' });
        u.reset?.();
        panel?.syncMyWheels?.();
      }
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

  if (reason === 'quota') {
    // 记下：轮毂额度用尽 + 是哪张照片触发的，便于同一张再次上传时直接拦截
    if (kind === 'wheel') {
      app._wheelQuotaExceeded = true;
      app._wheelQuotaDate = todayYMD();
      app._wheelLastSig = app._wheelPendingSig || '';
    }
    u.setStatus('今日 hy-3d 生成额度已用完', 'warn');
    u.setDetail([
      '当前凭证今日提交次数已达上限（通常为 5 次/天），本次没有消耗额外额度。',
      '建议：① 明天再试；② 点下方「改用演示模型」继续调试装车、悬挂、校准效果。',
      e.detail ? `云端返回：${String(e.detail).slice(0, 200)}` : '',
    ]);
    u.setActions([
      {
        label: '额度重置后，用同样的照片重试',
        tone: 'primary',
        onClick: () => runGenerate({ kind, images }),
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

/** 把 /api/health 回包按指定引擎翻成状态卡的四态 */
function classifyHealth(h, engine = 'hunyuan') {
  if (!h?.ok) return 'unknown';
  const e = h.engines?.[engine];
  if (engine === 'higen3d') {
    return e?.available ? 'live' : 'demo';
  }
  if (e?.mode !== 'live') return 'demo';
  // 云端已经拒过这张票，比文件里声明的过期时间更可信
  if (e.tokenId && rejectedTokenIds.has(e.tokenId)) return 'expired';
  // Hyper3D / fal 等 API Key 无固定过期时间，expiresAt 为 null 时直接视为 live
  if (!e.expiresAt) return 'live';
  const left = new Date(e.expiresAt).getTime() - Date.now();
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
/**
 * 引擎优先级。画质/可控性从高到低排列：
 *   fal     = fal.ai 上的 Rodin（按次计费，Gen-2.5 高/极限档，可加 4K HighPack）
 *   hyper3d = Hyper3D 官方 Rodin（需 Business 订阅）
 *   hunyuan = 腾讯混元（免费但每天 5 次，精度相对低）
 *   higen3d = HiGen3D（待配置）
 */
const ENGINE_PRIORITY = ['fal', 'hyper3d', 'hunyuan', 'higen3d'];

/** 从 health 里挑一个真正配了凭证的引擎；都不可用则返回 null */
function pickLiveEngine(engines) {
  for (const id of ENGINE_PRIORITY) {
    const e = engines?.[id];
    if (!e) continue;
    if (id === 'higen3d') {
      if (e.available) return id;
      continue;
    }
    if (e.mode === 'live') return id;
  }
  return null;
}

async function refreshHealth() {
  const h = await health();
  let engine = app.params.engine || 'hunyuan';
  const isEngineLive = (id) => {
    if (id === 'higen3d') return !!h.engines?.[id]?.available;
    return h.engines?.[id]?.mode === 'live';
  };

  // 当前引擎没凭证时自动切到有凭证的引擎。
  // 否则会出现"配了混元 key，却因为默认引擎是没 key 的 hyper3d 而一直跑 DEMO"的假死状态。
  if (!isEngineLive(engine)) {
    const better = pickLiveEngine(h.engines);
    if (better) {
      console.warn(`[engine] 引擎 ${engine} 无可用凭证，自动切换到 ${better}`);
      engine = better;
      app.params.engine = better;
    }
  }
  // 下拉框是在面板构建时按当时的 engine 初始化的，回退后要同步过去
  panel.syncEngine?.();

  // 切换后按最终引擎重新计算状态；状态卡必须反映"当前引擎"是否真的能跑 LIVE
  const engineStatus = h.engines?.[engine] || { mode: 'demo' };
  const state = classifyHealth(h, engine);
  const isLive = engine === 'higen3d' ? !!engineStatus.available : engineStatus.mode === 'live';
  const effectiveState = !isLive && state === 'live' ? 'demo' : state;

  panel.setMode({
    state: effectiveState,
    expiresAt: engineStatus.expiresAt || '',
    // 区分"时间到了"和"票被云端拒了"：后者文件里写的有效期不可信，不能再显示"还有 xx 小时"
    rejected: !!(engineStatus.tokenId && rejectedTokenIds.has(engineStatus.tokenId)),
    // LIVE 正常时不挂按钮，保持面板干净；其余三态都需要用户动手
    onRefresh: effectiveState === 'live' ? null : refreshHealth,
    engine,
    engineMode: isLive ? 'live' : 'demo',
  });
  return effectiveState;
}

// 挂到 app 上，供面板切换引擎后立即刷新状态卡
app.refreshHealth = refreshHealth;

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
let currentCarUrl = null; // 当前已载入的车模 URL，用于判断切换方案时是否需要重新载车

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
    rig.useProceduralWheel(app.params.rimPreset);
    app.apply();

    // 轮毂模板源（共享资源，只载一次）；载车统一交给 enterTuner，
    // 由 loadPlanCar() 按当前方案各自载入，确保「每个方案独立、互不被污染」。
    const wheelOk = await fetch('/models/wheel.glb', { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false);
    if (wheelOk) await app.loadWheelFromUrl('/models/wheel.glb');
  })();
}

// 调试入口：追加 chassis / shellCutter 供 CDP 验证脚本读取
// ⚠️ 全文件只能有这一处赋值：早期在文件末尾还有一份，会把这份覆盖掉，
//    导致 CDP 验证脚本拿到的 app/rig 是旧快照、panel 永远是 undefined。
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
  // panel 是启动后才赋值的，用 getter 拿，避免快照到 undefined
  get panel() {
    return panel;
  },
  // 当前编辑中的方案 / 已载入车模 URL（调试与自动化验证用）
  get currentPlan() {
    return currentPlan;
  },
  get currentCarUrl() {
    return currentCarUrl;
  },
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
  // 每次进入方案都清掉上一轮可能残留的拆解产物 / 异常轮毂，避免旧状态污染新车
  clearBangParts();
  resetWheelToProcedural();
  if (!panel) return;
  panel.syncAll();
  if (plan?.title) panel.carUpload.setTaskName(plan.title);
  // 车已载入时按方案参数完整重算底盘 / 轮位；未载入时 boot 会用这套参数载入
  if (typeof carGroup !== 'undefined' && carGroup) app.refitCar({ recapture: false });
  else app.apply();
  // 车漆色随方案恢复（carGroup 为空时由 boot 的 loadCarFromUrl 接管上色）
  if (typeof carGroup !== 'undefined' && carGroup) app.setBodyColor(app.params.bodyColor, app.params.bodySolid);
  if (panel?.syncColor) panel.syncColor();
  // 拆解产物恢复统一放到 loadPlanCar()：必须等「本方案的车」载好之后再装配，
  // 否则会把新方案的部件挂到上一方案的旧车上。
}

/**
 * 把方案对应的「拆开的实体车身」装回场景。
 *
 * 三级取值，能不花额度就不花：
 *   ① 方案自己带着 bangParts（上次生成时存下来的）
 *   ② 方案没带，但这台车以前拆过 → 查服务端 BANG 索引（零额度）
 *   ③ 都没有 → 保持未拆解的整车，面板给出「重新拆解」提示
 */
async function restoreBangForPlan() {
  const carLoaded = typeof carGroup !== 'undefined' && carGroup;
  if (!carLoaded) {
    panel?.syncBang?.();
    return;
  }
  let parts = (currentPlan?.bangParts || []).filter((p) => p?.url);
  if (!parts.length && currentPlan?.carModelUrl) {
    parts = (await lookupBangParts(currentPlan.carModelUrl)) || [];
    if (parts.length && currentPlan) currentPlan.bangParts = parts;
  }
  const sig = parts.map((p) => p?.url).join('|');
  if (sig && sig !== bangMountedSig) {
    await app
      .applyBangParts(parts)
      .catch((e) => console.warn('[bang] 恢复拆解部件失败：', e.message));
  }
  panel?.syncBang?.();
}

// 按当前方案载入「它自己的车模」：每个方案独立载车，互不污染。
// 切换方案时若车模 URL 没变则跳过重复下载（个人奔驰车同理只载一次）。
async function loadPlanCar() {
  const src = currentPlan?.carModelUrl || '/models/my-car.glb';
  if (src !== currentCarUrl) {
    await app.loadCarFromUrl(src);
    currentCarUrl = src;
  }
  // 车已载入：按本方案参数重算底盘 / 轮位，并还原车漆着色
  if (typeof carGroup !== 'undefined' && carGroup) {
    app.refitCar({ recapture: false });
    app.setBodyColor(app.params.bodyColor, app.params.bodySolid);
  }
  // 方案保存了自定义轮毂 → 重新载入；失败只记日志，保留程序化兜底
  if (currentPlan?.params?.customWheelUrl) {
    await app.loadWheelFromUrl(currentPlan.params.customWheelUrl).catch((e) => {
      console.warn('[plan] 恢复自定义轮毂失败：', e.message);
    });
  }
  // 方案自带 / 服务端索引的拆解产物按原坐标装配回整车（零额度）
  await restoreBangForPlan();
  app.fitCamera();
  app.setView('iso');
}

// 进入第二层 TUNING STUDIO
async function enterTuner(plan) {
  // —— 新建方案：一份完全独立的空白方案，初始化数据全部归零（仅取中性默认值）——
  if (!plan) {
    plan = {
      id: 'plan-' + Date.now(),
      title: '未命名方案',
      desc: '',
      tags: [],
      params: structuredClone(DEFAULTS), // 深拷贝，避免与全局 DEFAULTS 共享引用
      carModelUrl: '/models/my-car.glb', // 彩蛋：预设车模 = 个人上传的奔驰车
      bangParts: [],
    };
  } else {
    // 进入已有方案：深拷贝，避免与车库卡片列表共享同一对象导致方案之间互相污染
    plan = structuredClone(plan);
    if (!plan.params) plan.params = structuredClone(DEFAULTS);
    if (!plan.carModelUrl) plan.carModelUrl = '/models/my-car.glb';
    if (!plan.bangParts) plan.bangParts = [];
  }
  currentPlan = plan;

  const garageEl = document.getElementById('garage');
  if (garageEl) garageEl.classList.add('hidden');
  startTuner(); // 首次进入做一次性初始化（载车已下放到 loadPlanCar）
  applyPlanToApp(currentPlan); // 注入参数、清空上一方案残留的拆解/轮毂、同步 UI
  await loadPlanCar(); // 按本方案载车 + 还原车漆 + 装配拆解部件
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
      carModelUrl: currentPlan.carModelUrl || '',
      // 自动拆解出的部件随之保存，回到方案时不用重新拆（省额度）
      bangParts: currentPlan.bangParts || [],
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
// 门禁：未登录先弹登录浮层，登录成功后再挂载车库；注销/令牌失效回到浮层。
async function bootGarage() {
  const user = await fetchMe();
  if (!user) {
    showAuthOverlay((u) => {
      mountGarageEntry(u);
    });
    return;
  }
  mountGarageEntry(user);
}

function mountGarageEntry() {
  // 已登录：确保浮层隐藏，挂载/重挂车库
  garage = mountGarage({
    onEnter(plan) {
      enterTuner(plan);
    },
  });
}

// 第二层顶部「返回灵感车库 · 保存」按钮
document.getElementById('back-to-garage')?.addEventListener('click', returnToGarage);

// 登录态变化（来自 auth.js：登录成功 / 401 失效 / 主动注销）
window.addEventListener('auth:change', (e) => {
  const user = e.detail?.user;
  if (!user) {
    // 已登出：卸载车库，回到登录浮层
    if (garage) {
      garage.root?.classList?.add('hidden');
    }
    showAuthOverlay(() => {
      mountGarageEntry();
    });
  }
});

// 启动门禁
void bootGarage();

/* 调试入口统一在文件上方（window.__garage 只赋值一次），
 * 这里不再重复赋值——重复会把上面那份覆盖掉。 */
