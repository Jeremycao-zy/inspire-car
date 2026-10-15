/**
 * clearance.js — 轮胎扫掠间隙检测（纯几何，纯函数，可 Node 直接单测）
 *
 * ## 为什么要有这个模块
 * 之前「是否蹭胎」只是一条标量减法（suspension.js: `fenderGap = baseFenderGapMm − deltaMm`），
 * 配 10mm 绿 / 5mm 黄两个阈值。这**不是物理验证**：它既不知道胎宽变化后胎面外缘在哪，
 * 也不知道满打方向时胎体往哪儿扫。本模块把这三件事补上：
 *   1. 把轮胎建成**旋转体**（不是三角网格），解析地求出任意姿态下的包络；
 *   2. 把「悬架行程 × 轮心增益」「绕主销转向」「倾角」三个真实自由度建成工况；
 *   3. 对 4 角 × 5 工况逐项给出 5 个方向的间隙与干涉判定。
 *
 * ## 建模假设总表（每一条都在下面代码处单独标注了「实测依据」或「简化假设」）
 *   A1 轮胎断面非矩形：胎侧外鼓（最大断面宽在 r=Rbead+0.30H）+ 胎肩圆角 + 胎冠弧面。
 *      → 简化假设（断面轮廓无公开逐点数据，按乘用车通用断面拟合）。
 *   A2 轮拱顶 = 以轮心竖直轴为轴、半径 `archRadius` 的圆柱面 → 实测依据（tireBasis 语义）。
 *   A3 翼子板外沿（fender-lip）视为**平面**，且只存在于轮心以上（y′ ≥ 0）；
 *      轮心以下由门槛/侧裙约束，其 Z 向位置远在轮胎外缘之外，故不建模 → 简化假设。
 *   A4 转向轴 = 过轮心的**竖直轴**。casterTrail（主销后倾拖距）与 scrubRadius
 *      （主销下偏距）在底座中不存在 → **显式假设为 0**，属简化假设。
 *      代价：主销后倾会使轮胎在转向时额外前移，真实风险被低估。
 *   A5 轮心外移**只由 ET 决定**（复用 wheelPlacement 的物理结论）：`hubOffset = oeEt − et`。
 *   A6 `archLip`（翼子板外沿半宽）在底座里是**估算值、不可信**，本模块**不用它当几何基准**。
 *
 * ## 坐标系（每个角的局部系，原点 = 轮心）
 *   +x 车辆前方 / +y 上 / +z 车身外侧
 *   旋转顺序：先**倾角**（绕 x 轴，负 = 上部向内 = 负外八），再**转向**（绕 y 轴）。
 *   两次都是刚体旋转，因此**轮心到胎体任一点的距离恒等于该点的旋转半径**。
 *
 * ## 单位
 *   本模块内部**一律 mm**（与 tireBasis.js / wheelPlacement.js 一致）。
 *   刻意**不 import chassis.js**（它是米制），也**不 import three**（保证 Node 可跑）。
 */

import {
  getBasis, legalizeSpec, ET_VALUES_MM, TIRE_WIDTHS_MM, TIRE_ASPECTS, RIM_DIAMETERS_IN,
} from './tireBasis.js';
import { hubOffsetMm, rimWidthMm } from './wheelPlacement.js';

/* ----------------------------- 判定阈值 ----------------------------- */

/**
 * 判定阈值（mm）。**口径与 suspension.js 的 FENDER_SAFE_MM(10) / FENDER_MIN_MM(5) 严格一致**，
 * 保证同一条数据在「悬挂降低」页与「精准适配」页不会给出互相矛盾的结论。
 */
export const THRESH = {
  /** ≥ 10mm 判定安全 */
  ok: 10,
  /** 5 ~ 10mm 判定警告 */
  warn: 5,
  /** < 5mm 判定干涉；< 0 为实际几何干涉（蹭胎） */
  interfere: 5,
};

/** 5 个间隙方向（顺序即 `gaps` 键顺序，UI 渲染依赖它） */
export const GAP_DIRECTIONS = ['top', 'outer', 'inner', 'fore', 'aft'];

/** 各方向的默认障碍物标识 */
export const GAP_OBSTACLES = {
  top: 'fender-arch',     // 轮拱顶
  outer: 'fender-lip',    // 翼子板外沿
  inner: 'brake-caliper', // 卡钳 / 避震内摆包络
  fore: 'fender-edge',    // 轮拱开口前缘
  aft: 'fender-edge',     // 轮拱开口后缘
};

/** 方向的中文名（suggestFix 生成自然语言时用） */
export const GAP_LABELS = {
  top: '轮拱顶部', outer: '翼子板外沿', inner: '内侧卡钳/避震', fore: '轮拱前缘', aft: '轮拱后缘',
};

/** 工况定义。`steer` 只对前轴有效，后轴在 lock/bumpLock 下不参与判定。 */
export const CONDITIONS = {
  static: { id: 'static', label: '静止', rise: 0, steer: 0 },
  bump: { id: 'bump', label: '满压缩', rise: 1, steer: 0 },
  droop: { id: 'droop', label: '满回弹', rise: -1, steer: 0 },
  lock: { id: 'lock', label: '满打方向', rise: 0, steer: 1 },
  bumpLock: { id: 'bumpLock', label: '满压缩+满打方向', rise: 1, steer: 1 },
};

export const CORNER_LABELS = { FL: '左前', FR: '右前', RL: '左后', RR: '右后' };

/* ----------------------------- 可调几何余量 ----------------------------- */

/**
 * 以下三个是**建模余量**，不是车型数据。底座缺少「翼子板外沿实测半宽」与
 * 「轮拱开口前后缘实测位置」，只能以「原厂状态 + 定余量」的方式自洽标定。
 * 一旦拿到实测数据，用 `analyzeAll(..., { ... })` 覆盖即可，无需改建模。
 */
export const DEFAULT_OPTIONS = {
  /**
   * 翼子板外沿比「原厂胎面外缘」再靠外的量（mm）。
   * 简化假设：原厂状态下前翼子板最宽处比胎面外缘靠外 20~50mm（运动型车 flush fitment 的常见量），取 30。
   */
  fenderSkinAllowanceMm: 30,
  /**
   * 轮拱开口前后缘比「原厂轮胎前后缘」再让出的量（mm）。简化假设，取 30。
   */
  archEdgeAllowanceMm: 30,
  /**
   * 内侧障碍（卡钳 + 避震内摆）的作用高度带半高 = 系数 × OD/2。默认 0 = 全高有效。
   *
   * 简化假设说明：底座只给了 brakeHalf / shockHalf 两个「到轮心的 Z 向距离」，
   * 没给它们的高度范围。真实卡钳只覆盖胎体下部约 1/3 高度，但**保守起见默认按全高判定**
   * —— 高估约束比低估安全。若将来拿到实测高度范围，调这个系数即可收紧。
   */
  innerObstacleBandK: 0,
  /**
   * 采样密度。确定性计算，不含随机数；这两个值只影响精度与耗时。
   */
  profileSamples: 121,
  spinSamples: 180,
};

const DEG = Math.PI / 180;

/* ----------------------------- 小工具 ----------------------------- */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** 三次平滑插值，端点一阶导为 0 —— 用于胎肩圆滑过渡 */
function smoothstep(t) { return t * t * (3 - 2 * t); }

/** 保留 1 位小数，消除浮点尾噪（输出可读 + 便于严格相等断言） */
function r1(v) { return Math.round(v * 10) / 10; }

/* ----------------------------- 轮胎断面几何 ----------------------------- */

/**
 * 轮胎断面参数（旋转体）。
 *
 * 断面按乘用车通用形态拟合（A1，简化假设）：
 *   r ∈ [Rbead, rWide]                胎侧：从轮辋口 `rimHalf` 外鼓到最大断面宽 `HW`
 *   r ∈ [rWide, rShoulderEnd]         胎肩：平滑收窄到胎面半宽 `treadHalf`
 *   r ∈ [rShoulderEnd, Rout]          胎冠：椭圆弧，中心 `Rout`（外径 OD 的半径），边缘低 `crownRise`
 *
 * 关键点：**胎面最宽处（胎冠中部，z=0，半径 Rout）比胎肩外缘（z=±treadHalf，半径 Rout−crownRise）
 * 靠内**；而整条轮胎的最大横向外缘在**胎侧鼓包**处（z=±HW）。这三点共同决定了
 * 「外侧间隙看胎侧、顶部间隙看胎冠、胎冠比胎肩靠内」的真实关系。
 *
 * @param {{rimInch:number,j:number,tireWidthMm:number,aspect:number}} spec
 */
export function tireGeometry(spec) {
  const W = spec.tireWidthMm;
  const aspectRatio = spec.aspect / 100;
  const rimDiameterMm = spec.rimInch * 25.4;
  const Rbead = rimDiameterMm / 2;              // 胎踵（轮辋座）半径
  const sectionHeight = W * aspectRatio;        // 断面高
  const ROuter = Rbead + sectionHeight;         // = OD/2
  const HW = W / 2;                             // 最大断面半宽
  const rimHalf = rimWidthMm(spec.j) / 2;       // 轮辋半宽
  const crownRise = clamp(0.012 * W, 1.5, 4);   // 胎冠弧高（mm）
  const shoulderR = clamp(0.05 * W, 8, 16);     // 胎肩圆角半径（mm）
  const treadHalf = Math.max(1, HW - shoulderR); // 胎面（接地印迹）半宽
  const rWide = Rbead + 0.30 * sectionHeight;   // 最大断面宽处的半径
  const rShoulderEnd = Math.max(rWide + 1e-6, ROuter - crownRise); // 胎面外缘半径
  return {
    W, HW, rimHalf, Rbead, sectionHeight, ROuter, crownRise, shoulderR,
    treadHalf, rWide, rShoulderEnd, outerDiameter: ROuter * 2,
  };
}

/**
 * 给定旋转半径 r，返回该半径处胎体的横向半宽 h(r)（mm）。
 * 单调分段：胎侧线性外鼓 → 胎肩平滑收窄 → 胎冠椭圆弧。
 */
export function halfWidthAtRadius(geom, r) {
  if (r <= geom.Rbead) return geom.rimHalf;
  if (r >= geom.ROuter) return 0;
  if (r <= geom.rWide) {
    const t = (r - geom.Rbead) / Math.max(1e-6, geom.rWide - geom.Rbead);
    return geom.rimHalf + (geom.HW - geom.rimHalf) * t;
  }
  if (r <= geom.rShoulderEnd) {
    const t = (r - geom.rWide) / Math.max(1e-6, geom.rShoulderEnd - geom.rWide);
    return geom.HW + (geom.treadHalf - geom.HW) * smoothstep(t);
  }
  const u = (r - geom.rShoulderEnd) / Math.max(1e-6, geom.crownRise);
  return geom.treadHalf * Math.sqrt(Math.max(0, 1 - u * u));
}

/**
 * 断面采样点（确定性）：等距采样 + 强制插入三个断面特征半径
 * （胎踵、最大断面宽、胎面外缘、外缘），保证极值点被精确取到。
 *
 * @returns {{r:number,h:number}[]}
 */
export function tireProfilePoints(spec, nSamples = DEFAULT_OPTIONS.profileSamples) {
  const geom = tireGeometry(spec);
  const radii = [];
  for (let i = 0; i <= nSamples; i++) {
    radii.push(geom.Rbead + ((geom.ROuter - geom.Rbead) * i) / nSamples);
  }
  // 特征半径必须精确入列（顶部/内外极值往往正好落在这里）
  for (const r of [geom.Rbead, geom.rWide, geom.rShoulderEnd, geom.ROuter]) radii.push(r);
  radii.sort((a, b) => a - b);
  const out = [];
  for (const r of radii) {
    const rr = clamp(r, geom.Rbead, geom.ROuter);
    if (out.length && Math.abs(out[out.length - 1].r - rr) < 1e-9) continue;
    out.push({ r: rr, h: halfWidthAtRadius(geom, rr) });
  }
  return out;
}

/* ----------------------------- 位姿与包络 ----------------------------- */

/**
 * 建立轮姿态（倾角 → 转向）。
 * @param {number} camberDeg 负外八（负值），单位度
 * @param {number} steerDeg  绕竖直轴转向角，单位度（取 |值|）
 */
function makePose(geom, camberDeg, steerDeg) {
  const gamma = camberDeg * DEG;
  const delta = steerDeg * DEG;
  return {
    cg: Math.cos(gamma), sg: Math.sin(gamma),
    cd: Math.cos(delta), sd: Math.sin(delta),
    camberDeg, steerDeg,
    geom,
  };
}

/**
 * 把胎体上一点（旋转半径 r、横向偏移 zt、自转角 θ）变换到车身系。
 * 顺序：先绕 x 轴倾角 γ，再绕 y 轴转向 δ。
 */
function posePoint(r, zt, sinT, cosT, pose) {
  const x1 = r * cosT;
  const y2 = r * sinT * pose.cg - zt * pose.sg;
  const z1 = r * sinT * pose.sg + zt * pose.cg;
  return { x: x1 * pose.cd + z1 * pose.sd, y: y2, z: -x1 * pose.sd + z1 * pose.cd };
}

/**
 * 全胎体包络（一次扫描同时得到 4 个量）：
 *   - topReach  = max √(x²+y²)  轮拱顶判定用（轮拱是以轮心竖直轴为轴的圆柱面）
 *   - foreReach = max  x
 *   - aftReach  = max −x
 *   - innerReach= max −z        内侧包络（内衬/卡钳是深腔，全胎体都受约束）
 */
function fullEnvelope(profile, pose, nSpin) {
  let topReach = 0, foreReach = 0, aftReach = 0, innerReach = 0;
  const trig = [];
  for (let j = 0; j < nSpin; j++) {
    const t = (j * 2 * Math.PI) / nSpin;
    trig.push([Math.sin(t), Math.cos(t)]);
  }
  for (const { r, h } of profile) {
    for (const zt of [h, -h]) {
      for (let j = 0; j < nSpin; j++) {
        const p = posePoint(r, zt, trig[j][0], trig[j][1], pose);
        const planar = Math.sqrt(p.x * p.x + p.y * p.y);
        if (planar > topReach) topReach = planar;
        if (p.x > foreReach) foreReach = p.x;
        if (-p.x > aftReach) aftReach = -p.x;
        if (-p.z > innerReach) innerReach = -p.z;
      }
    }
  }
  return { topReach, foreReach, aftReach, innerReach };
}

/**
 * 前/后中心截面（x′ = 0 的平面）上的横向极值 —— 解析求解，不靠网格近似。
 *
 * 为什么需要它：翼子板外沿（fender-lip）与卡钳/避震面对的是轮胎**前、后中心那条截面**，
 * 而不是整条胎体的最外点。直接用全胎体包络会严重高估（满打方向时胎体横向外伸 250mm+
 * 全部来自前/后端，而那里是轮拱开口，不是平面唇口 / 卡钳）。
 *
 * 推导：x′(θ) = A cosθ + B sinθ + C 是 θ 的正弦型，令 x′=0 可解析求解。
 *
 * @param {number} innerBandHalfHeight 内侧障碍的作用高度带半高（mm）；超过该高度的胎体不参与 inner 判定
 */
function sectionEnvelope(profile, pose, innerBandHalfHeight = Infinity) {
  let outerMaxZ = -Infinity;  // 上半段（y′ ≥ 0，翼子板所在侧）最外点
  let innerMinZ = Infinity;   // 障碍高度带内截面的最内点
  for (const { r, h } of profile) {
    for (const zt of [h, -h]) {
      const A = r * pose.cd;
      const B = r * pose.sg * pose.sd;
      const C = zt * pose.cg * pose.sd;
      const R = Math.sqrt(A * A + B * B);
      if (R < 1e-9) continue;
      const ratio = clamp(-C / R, -1, 1);
      const base = Math.atan2(B, A);            // A cosθ + B sinθ = R cos(θ − base)
      for (const sign of [1, -1]) {
        const theta = base + sign * Math.acos(ratio);
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        const p = posePoint(r, zt, sinT, cosT, pose);
        if (p.y >= 0 && p.z > outerMaxZ) outerMaxZ = p.z;
        if (Math.abs(p.y) <= innerBandHalfHeight && p.z < innerMinZ) innerMinZ = p.z;
      }
    }
  }
  return {
    outerMaxZ: Number.isFinite(outerMaxZ) ? outerMaxZ : 0,
    innerMinZ: Number.isFinite(innerMinZ) ? innerMinZ : 0,
  };
}

/* ----------------------------- 单角单工况求解 ----------------------------- */

/**
 * 求解「一个角 × 一个工况」的全部间隙。
 *
 * @param {Object} o
 * @param {object} o.spec          该轴当前规格（已 legalize）
 * @param {object} o.basis         车型底座
 * @param {'front'|'rear'} o.axle
 * @param {number} o.camberDeg
 * @param {number} o.riseMm        轮心相对车身上移量（mm，压缩为正、回弹为负）
 * @param {number} o.steerDeg      转向角（度）
 * @param {object} o.options
 */
function solveOne({ spec, basis, axle, camberDeg, riseMm, steerDeg, options }) {
  const g = basis.geometry;
  const front = axle === 'front';
  const halfTrack = front ? g.halfTrackF : g.halfTrackR;
  const archRadius = front ? g.archRadiusF : g.archRadiusR;
  const oeSpec = basis[axle];
  const brakeHalf = front ? g.brakeHalfF : g.brakeHalfR;
  const shockHalf = front ? g.shockHalfF : g.shockHalfR;

  const geom = tireGeometry(spec);
  const profile = tireProfilePoints(spec, options.profileSamples);
  const pose = makePose(geom, camberDeg, steerDeg);
  const full = fullEnvelope(profile, pose, options.spinSamples);
  // band=0 表示「不设高度带」，即全高保守判定
  const innerBand = options.innerObstacleBandK > 0
    ? options.innerObstacleBandK * geom.ROuter
    : Infinity;
  const section = sectionEnvelope(profile, pose, innerBand);

  // A5：轮心外移只由 ET 决定（复用 wheelPlacement 的结论）
  const hubOff = hubOffsetMm(spec.et, oeSpec.et);

  // --- top：轮拱顶（实测依据：archRadius 语义 = 轮心到轮拱顶） ---
  // 轮心相对车身上移 riseMm → 胎体同步上移 → 顶部间隙直接减少 riseMm
  const topGap = archRadius - full.topReach - riseMm;

  // --- outer：翼子板外沿平面 vs 胎体前/后中心截面的上半段最外点 ---
  //   A3 简化假设：唇口只在轮心以上存在；余量 = 原厂胎面外缘再往外 allowance
  const oeTreadHalf = oeSpec.tireWidthMm / 2;
  const fenderSkinZ = halfTrack + oeTreadHalf + options.fenderSkinAllowanceMm; // 相对车身中线
  const outerGap = (fenderSkinZ - (halfTrack + hubOff)) - section.outerMaxZ;

  // --- inner：内侧障碍包络 vs 胎体截面上最内点 ---
  //   实测/标称依据：brakeHalf / shockHalf 是「**到轮心的** Z 向距离」（不是到车身中线）。
  //   障碍面 Z = 轮心 Z − min(brakeHalf, shockHalf)，减胎体内缘即得间隙。
  const innerObstacleDepth = Math.min(brakeHalf, shockHalf);   // 障碍相对轮心向内的深度
  const innerGap = innerObstacleDepth + section.innerMinZ;

  // --- fore / aft：轮拱开口前后缘 vs 胎体前后极值 ---
  const oeHalfLen = tireGeometry(oeSpec).ROuter;
  const archHalfLen = oeHalfLen + options.archEdgeAllowanceMm;
  const foreGap = archHalfLen - full.foreReach;
  const aftGap = archHalfLen - full.aftReach;

  const gaps = {
    top: { value: r1(topGap), obstacle: GAP_OBSTACLES.top },
    outer: { value: r1(outerGap), obstacle: GAP_OBSTACLES.outer },
    inner: { value: r1(innerGap), obstacle: GAP_OBSTACLES.inner },
    fore: { value: r1(foreGap), obstacle: GAP_OBSTACLES.fore },
    aft: { value: r1(aftGap), obstacle: GAP_OBSTACLES.aft },
  };
  const minGap = Math.min(...GAP_DIRECTIONS.map((k) => gaps[k].value));
  return { gaps, minGap, verdict: verdictOf(minGap), detail: { hubOff, camberDeg, steerDeg, riseMm, outerDiameter: geom.outerDiameter } };
}

/** 判定：≥THRESH.ok 安全 / ≥THRESH.warn 警告 / 否则干涉（<0 为实际蹭胎） */
export function verdictOf(gapMm) {
  if (gapMm >= THRESH.ok) return 'ok';
  if (gapMm >= THRESH.warn) return 'warn';
  return 'interfere';
}

/* ----------------------------- 对外主 API ----------------------------- */

/** 把 options 与默认值合并 */
function withOptions(options) {
  return { ...DEFAULT_OPTIONS, ...(options || {}) };
}

/** 合并底座原厂规格与用户改写 */
function mergeSpec(base, override) {
  const merged = { ...base, ...(override || {}) };
  return legalizeSpec(merged);
}

/**
 * 分析四轮（可直接传底座对象，便于用 est 级假数据单测降级逻辑）。
 *
 * @param {object} basis        TIRE_BASIS 里的一条（或任意同构对象）
 * @param {object} specFront    前轴改写（可省，省略即原厂）
 * @param {object} specRear     后轴改写（可省，省略即原厂）
 * @param {object} [options]    见 DEFAULT_OPTIONS
 * @returns {object} { available, referenceOnly, results, summary }
 */
export function analyzeWithBasis(basis, specFront, specRear, options) {
  const opt = withOptions(options);
  if (!basis) return { available: false, reason: 'not-in-basis' };

  const g = basis.geometry;
  const frontSpec = mergeSpec(basis.front, specFront);
  const rearSpec = mergeSpec(basis.rear, specRear);

  /** 每个角的条件函数：轮心升降 + 转向 */
  const axleState = (axle) => {
    const front = axle === 'front';
    const travel = front ? g.suspTravelF : g.suspTravelR;
    const rebound = front ? g.reboundF : g.reboundR;
    const gain = front ? g.wheelCenterGainF : g.wheelCenterGainR;
    const steerDeg = front ? (g.steerDeg || 0) : 0; // A4 简化：后轴不转向
    return { travel, rebound, gain, steerDeg, halfTrack: front ? g.halfTrackF : g.halfTrackR };
  };

  const results = [];
  for (const [corner, axle] of [['FL', 'front'], ['FR', 'front'], ['RL', 'rear'], ['RR', 'rear']]) {
    const st = axleState(axle);
    const spec = axle === 'front' ? frontSpec : rearSpec;
    for (const cond of Object.values(CONDITIONS)) {
      const steered = cond.steer === 1 && st.steerDeg > 0;
      // 后轮在满打方向工况下不参与判定（同轴两轮反向、间隙对称，见工单约定）
      if (cond.steer === 1 && !steered) continue;
      const riseMm = cond.rise === 1 ? st.travel * st.gain : cond.rise === -1 ? -st.rebound * st.gain : 0;
      const solved = solveOne({
        spec, basis, axle,
        camberDeg: spec.camber || 0,
        riseMm,
        steerDeg: steered ? st.steerDeg : 0,
        options: opt,
      });
      results.push({
        corner, axle,
        cornerLabel: CORNER_LABELS[corner],
        condition: cond.id,
        conditionLabel: cond.label,
        steered,
        gaps: solved.gaps,
        minGap: solved.minGap,
        verdict: solved.verdict,
        detail: solved.detail,
      });
    }
  }

  const values = results.map((r) => r.minGap);
  const summary = {
    minGap: values.length ? Math.min(...values) : null,
    verdict: values.length ? verdictOf(Math.min(...values)) : 'ok',
    okCount: results.filter((r) => r.verdict === 'ok').length,
    warnCount: results.filter((r) => r.verdict === 'warn').length,
    interfereCount: results.filter((r) => r.verdict === 'interfere').length,
    rows: results.length,
  };

  return {
    available: true,
    basisKey: basis.key || null,
    name: basis.name || null,
    confidence: basis.confidence || null,
    // est 级（任一项为估算）必须标 referenceOnly，UI 据此不得给判定结论
    referenceOnly: basis.confidence === 'est',
    canJudge: basis.confidence === 'oe' || basis.confidence === 'db',
    specs: { front: frontSpec, rear: rearSpec },
    options: opt,
    results,
    summary,
  };
}

/**
 * 对外入口：按车型 key 做全车扫掠间隙分析。
 *
 * 降级：**未建档车型一律返回 `{ available:false, reason:'not-in-basis' }`，
 * 绝不返回任何数字** —— 没有几何底座时编一个数比不给结论危害大得多。
 *
 * @param {string} basisKey  车型 key（如 mercedes-sl350-r230）
 * @param {object} [specFront]
 * @param {object} [specRear]
 * @param {object} [options]
 */
export function analyzeAll(basisKey, specFront, specRear, options) {
  const basis = getBasis(basisKey);
  if (!basis) return { available: false, reason: 'not-in-basis', basisKey: basisKey || null };
  const out = analyzeWithBasis(basis, specFront, specRear, options);
  out.basisKey = basisKey;
  return out;
}

/**
 * 全车最危险的一条（含角、工况、方向、数值）。
 * @param {object} result analyzeAll / analyzeWithBasis 的返回
 * @returns {object|null} 无数据返回 null
 */
export function worstCase(result) {
  if (!result || !result.available || !result.results || !result.results.length) return null;
  let worst = null;
  for (const row of result.results) {
    for (const dir of GAP_DIRECTIONS) {
      const value = row.gaps[dir].value;
      if (!worst || value < worst.value) {
        worst = {
          corner: row.corner,
          cornerLabel: row.cornerLabel,
          axle: row.axle,
          condition: row.condition,
          conditionLabel: row.conditionLabel,
          direction: dir,
          directionLabel: GAP_LABELS[dir],
          obstacle: row.gaps[dir].obstacle,
          value,
          verdict: row.verdict,
          interferes: value < 0,
        };
      }
    }
  }
  return worst;
}

/* ----------------------------- 建议（可复算验证） ----------------------------- */

/**
 * 候选调整方向，按「侵入性从小到大」排序。
 * 每个候选都是**单参数**调整，保证建议可解释、可复算。
 */
const FIX_STRATEGIES = [
  {
    id: 'et', label: 'ET', axis: true,
    candidates(spec, oe) { return etSteps(spec.et, oe.et); },
    apply(spec, to) { return { ...spec, et: to }; },
    describe(spec, to, oe) {
      const delta = to - spec.et;
      const toward = to === oe.et ? '回到原厂 ET' : `向原厂 ET${oe.et} 靠拢`;
      return `ET ${spec.et} → ${to}（${delta > 0 ? '+' : ''}${delta}mm，${toward}）`;
    },
  },
  {
    id: 'tireWidth', label: '胎宽', axis: false,
    candidates(spec) { return lowerSteps(TIRE_WIDTHS_MM, spec.tireWidthMm); },
    apply(spec, to) { return { ...spec, tireWidthMm: to }; },
    describe(spec, to) { return `胎宽 ${spec.tireWidthMm} → ${to}mm（−${spec.tireWidthMm - to}mm）`; },
  },
  {
    id: 'aspect', label: '扁平比', axis: false,
    candidates(spec) { return higherSteps(TIRE_ASPECTS, spec.aspect); },
    apply(spec, to) { return { ...spec, aspect: to }; },
    describe(spec, to) { return `扁平比 ${spec.aspect} → ${to}%（断面高减小，外径 ${tireGeometry(spec).outerDiameter.toFixed(0)} → ${tireGeometry({ ...spec, aspect: to }).outerDiameter.toFixed(0)}mm）`; },
  },
  {
    id: 'rimInch', label: '轮辋直径', axis: false,
    candidates(spec) { return lowerSteps(RIM_DIAMETERS_IN, spec.rimInch); },
    apply(spec, to) { return { ...spec, rimInch: to }; },
    describe(spec, to) { return `轮辋 ${spec.rimInch}" → ${spec.rimInch - 1}"（外径减小 ${tireGeometry(spec).outerDiameter.toFixed(0)} → ${tireGeometry({ ...spec, rimInch: to }).outerDiameter.toFixed(0)}mm）`; },
  },
  {
    id: 'camber', label: '倾角', axis: false,
    candidates(spec) { return camberSteps(spec.camber); },
    apply(spec, to) { return { ...spec, camber: to }; },
    describe(spec, to) { return `倾角 ${(spec.camber ?? 0).toFixed(1)}° → ${to.toFixed(1)}°（减小负外八）`; },
  },
];

/**
 * ET 候选：向原厂靠拢（含回到原厂），逐档 5mm 步进。
 * ⚠️ 必须保证每一步严格递增 —— 否则当起点已等于原厂 ET 时会死循环。
 */
function etSteps(cur, oe) {
  const out = [];
  if (oe > cur) {
    let v = Math.min(oe, snapUpEt(cur + 5));
    let guard = 0;
    while (v <= oe + 1e-9 && guard++ < 64) {
      out.push(v);
      if (v >= oe - 1e-9) break;          // 已到原厂，必须显式退出
      v = Math.min(oe, v + 5);
    }
  } else {
    for (const v of ET_VALUES_MM) if (v < cur) out.push(v);
  }
  return out;
}
function snapUpEt(v) {
  for (const e of ET_VALUES_MM) if (e >= v) return e;
  return ET_VALUES_MM[ET_VALUES_MM.length - 1];
}
/** 离散序列向下逐档 */
function lowerSteps(series, cur) { return series.filter((v) => v < cur).sort((a, b) => b - a); }
/** 离散序列向上逐档 */
function higherSteps(series, cur) { return series.filter((v) => v > cur).sort((a, b) => a - b); }
/** 倾角向 0 靠拢，0.5° 步进 */
function camberSteps(cur) {
  const c = cur ?? 0;
  if (c >= 0) return [];
  const out = [];
  for (let v = -0.5; v < 0; v = Math.round((v + 0.5) * 10) / 10) out.push(v);
  return out;
}

/**
 * 生成**可验证**的调整建议。
 *
 * 每条建议的做法都是：改一个参数 → 重新跑一遍全车扫掠分析 → 只有当
 * **同一个最危险工况的 minGap 确实达到 THRESH.ok（10mm）** 才认为「已解决」。
 * 所有候选都失败时，**诚实返回「无单参数解，建议回到原厂规格」**，绝不编造。
 *
 * @param {object} worst         worstCase 的返回
 * @param {string|object} basis  车型 key 或底座对象
 * @param {{front:object,rear:object}} currentSpecs 当前合法化后的前后轴规格
 * @param {object} [options]
 */
export function suggestFix(worst, basis, currentSpecs, options) {
  const b = typeof basis === 'string' ? getBasis(basis) : basis;
  if (!worst || !b || !currentSpecs) {
    return { resolved: false, suggestions: [], note: '缺少最危险工况或车型底座，无法给出建议。' };
  }
  const opt = withOptions(options);
  const baseSpecs = {
    front: mergeSpec(b.front, currentSpecs.front),
    rear: mergeSpec(b.rear, currentSpecs.rear),
  };
  const axle = worst.axle;
  const oeSpec = b[axle];
  const target = THRESH.ok;

  const evaluate = (specs) => {
    const res = analyzeWithBasis(b, specs.front, specs.rear, opt);
    const w = worstCase(res);
    return { res, w, minGap: w ? w.value : Infinity };
  };

  const attempts = [];
  for (const strat of FIX_STRATEGIES) {
    const spec = baseSpecs[axle];
    for (const to of strat.candidates(spec, oeSpec)) {
      const nextSpec = legalizeSpec(strat.apply(spec, to));
      if (JSON.stringify(nextSpec) === JSON.stringify(spec)) continue;
      const specs = { ...baseSpecs, [axle]: nextSpec };
      const { res, w, minGap } = evaluate(specs);
      const solved = minGap >= target;
      attempts.push({ strat, to, nextSpec, solved, minGap, after: w, res });
      if (solved) break; // 该参数下最小可用步进
    }
  }

  const solvedList = attempts.filter((a) => a.solved).sort((a, b) => a.minGap - b.minGap);
  if (!solvedList.length) {
    const best = attempts.slice().sort((a, b) => b.minGap - a.minGap)[0];
    return {
      resolved: false,
      suggestions: [{
        text: `${worst.cornerLabel}${worst.conditionLabel}时${worst.directionLabel}干涉 ${worst.value}mm；`
          + '穷举 ET / 胎宽 / 扁平比 / 轮辋 / 倾角 五类单参数调整均无法把间隙拉回 '
          + `${THRESH.ok}mm（最好只能到 ${best ? best.minGap : '—'}mm），建议回到原厂规格。`,
        change: null, verified: false,
      }],
      note: 'no-single-parameter-solution',
    };
  }

  const suggestions = solvedList.map((a) => ({
    text: `${worst.cornerLabel}（${worst.corner}）${worst.conditionLabel}时${worst.directionLabel}干涉 ${worst.value}mm；`
      + `建议${a.strat.label}：${a.strat.describe(baseSpecs[axle], a.to, oeSpec)}，`
      + `调整后全车最小间隙 ${worst.value}mm → ${a.minGap}mm（判定 ${a.after.verdict}）。`,
    change: {
      axle,
      parameter: a.strat.id,
      from: a.strat.id === 'camber' ? (baseSpecs[axle].camber ?? 0) : baseSpecs[axle][a.strat.id === 'tireWidth' ? 'tireWidthMm' : a.strat.id],
      to: a.to,
      spec: a.nextSpec,
    },
    verified: true,
    before: worst.value,
    after: a.minGap,
  }));

  return { resolved: true, suggestions, note: 'single-parameter-solution-found' };
}

export default {
  THRESH, GAP_DIRECTIONS, GAP_OBSTACLES, GAP_LABELS, CONDITIONS, CORNER_LABELS,
  DEFAULT_OPTIONS, analyzeAll, analyzeWithBasis, worstCase, suggestFix,
  tireGeometry, halfWidthAtRadius, tireProfilePoints, verdictOf,
};