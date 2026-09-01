/**
 * chassis.js — 底盘参数模型 + 程序化几何
 *
 * 新架构的核心（见 docs/increment-DESIGN-shell-chassis.md）：
 *
 * > 车轮不再从车壳里「挖」出来，而是本来就长在底盘上。
 * > 车壳退化为贴图外壳，底盘成为轮距 / 轴距 / 轮心高的**唯一真值来源**。
 *
 * 职责：
 *   1) ChassisParams.derive()  —— 从车壳测量值推导底盘主参数（带 clamp 兜底）
 *   2) Chassis.build()         —— 纯 Three.js 内置图元拼出底盘（≤3000 面，零新增依赖）
 *   3) cornerSpec()            —— 输出四轮位置给 WheelRig
 *   4) cutPlan()               —— 输出三道切割参数给 ShellCutter
 *
 * 依赖方向严格单向：本模块**不 import wheelRig.js**，也不 import shellCutter.js。
 * 可在 Node 里独立单测（除 build() 需要 three，其余为纯数学）。
 *
 * ⚠️ hubY 的取值：必须等于 WheelRig 的 axle.position.y（即 tireOuterRadius 未缩放值）。
 *    设计文档 §3.3 明确要求「轮毂座中心 与 WheelRig 的 axle 位置严格一致」，
 *    且 `_qa-edge-tire.mjs:411/416`、`verify.mjs:139` 把 axle.y 锁死为未缩放的
 *    tireOuterRadius —— 因此这里**不套** k = carLength/4.535 缩放。
 *    （设计附表里的 0.3353 / 0.3315 是套了 k 的值，与本实现的 0.33055 / 0.32680
 *     相差 4.7mm；一致性约束优先，见汇报说明。）
 */

import * as THREE from 'three';
import { tireOuterRadius } from './tire.js';
import { suspensionReadout as computeSuspensionReadout } from './suspension.js';

/* ------------------------------------------------------------------ */
/*                            常量                                     */
/* ------------------------------------------------------------------ */

/** R230 统计比例（设计 §3.2，实测推导） */
export const RATIO = {
  wheelbase: 0.5645, // 轴距 / 车长
  frontOverhang: 0.2029, // 前悬 / 车长
  rearOverhang: 0.2326, // 后悬 / 车长
  trackFront: 0.859, // 前轮距半 / 车身半宽
  trackRear: 0.852, // 后轮距半 / 车身半宽
  rideHeight: 0.0272, // 离地间隙 / 车长
  /**
   * 甲板高 / 车长（= C1 底切高度）。
   *
   * ⚠️ 设计文档给的是 0.0652（→0.300m），但那个值是在**没套 GLB 节点变换**
   *    （车上下颠倒）的几何上量出来的，不适用。
   *    在浏览器实际使用的朝向下，车壳底面（覆盖度仅 30% 的窄底板）在 y < 0.20，
   *    y ≥ 0.20 起就是完整长度的车身侧板 —— 切到 0.30 会把侧裙整条切掉。
   *    这里改到 0.0435（→0.200m），只切掉底板，侧板保留。
   */
  deckHeight: 0.0435,
  clipTopY: 0.1196, // C2 侧向切割的生效上限 / 车长（L=4.6 → 0.550）
};

/** 轮拱相对轮胎外半径的偏置（米） */
export const ARCH_CLEARANCE = 0.045;
/** 轮拱内边界相对轮胎内缘再往里的余量（米） */
export const ARCH_INNER_CLEARANCE = 0.02;
/** 侧向裁剪相对车身外表面的容差（米） */
export const CLIP_CLEARANCE = 0.015;

/** OE 配置（R230 19"），仅用于 Δouter / 车身升降的报告基准 */
export const OE_SPEC = {
  front: { rimInch: 19, j: 8.5, et: 30, tireWidthMm: 255, aspect: 35, camber: -1.0 },
  rear: { rimInch: 19, j: 9.5, et: 31, tireWidthMm: 285, aspect: 30, camber: -1.5 },
};

/** 底盘材质参数（设计 §3.5） */
const MAT_SPEC = {
  struct: { color: 0x3a3f47, metalness: 0.65, roughness: 0.55, envMapIntensity: 0.6 },
  disc: { color: 0x8a8f98, metalness: 0.9, roughness: 0.35, envMapIntensity: 0.9 },
  liner: { color: 0x14161a, metalness: 0.0, roughness: 0.95, envMapIntensity: 0.15 },
  caliper: { color: 0x9a1f2b, metalness: 0.3, roughness: 0.45, envMapIntensity: 0.7 },
};

/* ------------------------------------------------------------------ */
/*                         参数模型                                    */
/* ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class ChassisParams {
  constructor(init = {}) {
    this.carLength = init.carLength ?? 4.6;
    this.bodyHalfWidth = init.bodyHalfWidth ?? 0.93;

    // 主参数（A 组）
    this.wheelbase = init.wheelbase ?? 0;
    this.axleX_F = init.axleX_F ?? 0;
    this.axleX_R = init.axleX_R ?? 0;
    /**
     * axleX_F / axleX_R 是否来自**实测**（BANG 拆解测到的车轮质心 x，或车型库轴坐标）。
     * true 时 clampAll() / derive() 的兜底夹取对轴位置放宽为"合理性校验"，
     * 见 derive() Step 4 的注释——实测值被对称 clamp 截断等于白测。
     */
    this.axleXMeasured = init.axleXMeasured ?? false;
    this.halfTrack_F = init.halfTrack_F ?? 0;
    this.halfTrack_R = init.halfTrack_R ?? 0;
    this.hubY_F = init.hubY_F ?? 0;
    this.hubY_R = init.hubY_R ?? 0;
    this.rideHeight = init.rideHeight ?? 0;
    this.deckHeight = init.deckHeight ?? 0;
    this.floorT = init.floorT ?? 0.035;
    this.shellLift = init.shellLift ?? 0;

    // 派生参数（B 组）
    this.clipZ = init.clipZ ?? 0;
    this.clipTopY = init.clipTopY ?? 0;
    this.archR_F = init.archR_F ?? 0;
    this.archR_R = init.archR_R ?? 0;
    this.archInnerZ_F = init.archInnerZ_F ?? 0;
    this.archInnerZ_R = init.archInnerZ_R ?? 0;
    this.railHalfZ = init.railHalfZ ?? 0;
    this.floorHalfZ = init.floorHalfZ ?? 0;
    this.linerR_F = init.linerR_F ?? 0;
    this.linerR_R = init.linerR_R ?? 0;
    this.skirtH = init.skirtH ?? 0;
    this.discR = init.discR ?? 0;
  }

  /**
   * 从车壳测量值 + 轮轴参数推导全部主参数（设计 §3.2 四步）。
   * 若调用方传入了真实轴距 / 轮距 / 离地间隙（来自车型识别），则优先使用。
   *
   * @param {{bodyHalfWidth:number, lengthNorm?:number}} metrics ShellMeasure.measure() 的结果
   * @param {{front:Object, rear:Object}} axleParams {rimInch, tireWidthMm, aspect, ...}
   * @param {{wheelbase?:number, axleX_F?:number, axleX_R?:number,
   *          halfTrack_F?:number, halfTrack_R?:number, rideHeight?:number}} [real]
   *   真实参数，单位米。axleX_F / axleX_R 是前后轴的**绝对 x 坐标**（车长中心为 0、
   *   车头 +X），优先于由 wheelbase 推出来的对称 ±wheelbase/2。
   * @returns {ChassisParams} this（便于链式）
   */
  derive(metrics, axleParams, real = {}) {
    const L = this.carLength || metrics.lengthNorm || 4.6;
    const bhw = metrics.bodyHalfWidth;
    this.carLength = L;
    this.bodyHalfWidth = bhw;

    const front = axleParams?.front || OE_SPEC.front;
    const rear = axleParams?.rear || OE_SPEC.rear;

    // Step 3 — 推导主参数
    let wheelbase = RATIO.wheelbase * L;
    let axleX_F = L / 2 - RATIO.frontOverhang * L;
    let axleX_R = -(L / 2 - RATIO.rearOverhang * L);
    let halfTrack_F = RATIO.trackFront * bhw;
    let halfTrack_R = RATIO.trackRear * bhw;
    let rideHeight = RATIO.rideHeight * L;

    // 若车型识别提供了真实值，优先覆盖估算值
    //
    // ⚠️ 轴位置有三档优先级，不要退化成 ±wheelbase/2：
    //   ① real.axleX_F / axleX_R（实测绝对轴坐标）——最准，直接采信；
    //   ② ±real.wheelbase / 2 ——只知道轴距时的次优解；
    //   ③ RATIO 前后悬比例估算 ——什么都没有时的兜底。
    // 真实车的前后悬不等长，**轴距中心 ≠ 车身包围盒中心**，②③ 都是对称假设，
    // 会把两只轴整体平移同一个常量（BANG 样本实测偏差 11 / 41 / 98 mm）。
    let axleMeasured = false;
    if (Number.isFinite(real.wheelbase) && real.wheelbase > 0.5) {
      wheelbase = real.wheelbase;
    }
    if (
      Number.isFinite(real.axleX_F) &&
      Number.isFinite(real.axleX_R) &&
      real.axleX_F > real.axleX_R
    ) {
      axleX_F = real.axleX_F;
      axleX_R = real.axleX_R;
      axleMeasured = true;
    } else if (Number.isFinite(real.wheelbase) && real.wheelbase > 0.5) {
      axleX_F = wheelbase / 2;
      axleX_R = -wheelbase / 2;
    }
    if (Number.isFinite(real.halfTrack_F) && real.halfTrack_F > 0.2) {
      halfTrack_F = real.halfTrack_F;
    }
    if (Number.isFinite(real.halfTrack_R) && real.halfTrack_R > 0.2) {
      halfTrack_R = real.halfTrack_R;
    }
    if (Number.isFinite(real.rideHeight) && real.rideHeight > 0.05) {
      rideHeight = real.rideHeight;
    }

    /* Step 4 — 兜底 clamp（换车鲁棒性）
     *
     * 轴位置分两条路径，区别对待：
     *
     *   · 估算值（②③ 档）：走原来的对称 clamp [0.15L, 0.40L]。
     *     估算本来就是从"经验比例"推的，夹回经验区间能挡住离谱输出。
     *
     *   · 实测值（① 档）：**不做对称 clamp，只做合理性校验**。
     *     原 clamp 的上界 0.40L 是按"前悬 ≥ 0.10L"设计的兜底，但实测样本的
     *     后轴到车身中心距离普遍超过 0.40L（样本 2 达 0.311L… 见 QA 报告），
     *     一旦被截断，实测信息就退化回对称解，等于白测。
     *     校验只挡真正不可能的情况：轴跑到车身外、前后轴顺序颠倒、
     *     轴距超出整车物理范围。校验不过才退回 ±wheelbase/2 并重新走 clamp。
     */
    wheelbase = clamp(wheelbase, 0.45 * L, 0.68 * L);
    if (axleMeasured) {
      const span = axleX_F - axleX_R;
      const sane =
        Number.isFinite(span) &&
        span > 0.3 * L &&
        span < 0.95 * L &&
        axleX_F > 0 &&
        axleX_R < 0 &&
        axleX_F < 0.5 * L &&
        axleX_R > -0.5 * L;
      if (!sane) {
        axleMeasured = false;
        axleX_F = wheelbase / 2;
        axleX_R = -wheelbase / 2;
      }
    }
    if (!axleMeasured) {
      axleX_F = clamp(axleX_F, 0.15 * L, 0.40 * L);
      axleX_R = clamp(axleX_R, -0.40 * L, -0.15 * L);
    }
    halfTrack_F = clamp(halfTrack_F, 0.62 * bhw, 0.95 * bhw);
    halfTrack_R = clamp(halfTrack_R, 0.62 * bhw, 0.95 * bhw);
    halfTrack_F = Math.max(0.3, halfTrack_F);
    halfTrack_R = Math.max(0.3, halfTrack_R);
    rideHeight = clamp(rideHeight, 0.03, 0.4);

    this.wheelbase = wheelbase;
    this.axleX_F = axleX_F;
    this.axleX_R = axleX_R;
    this.axleXMeasured = axleMeasured;
    this.halfTrack_F = halfTrack_F;
    this.halfTrack_R = halfTrack_R;
    this.rideHeight = rideHeight;

    // 轮心高：严格等于 WheelRig 的 axle.position.y（未缩放 tireOuterRadius）
    this.hubY_F = tireOuterRadius(front.rimInch, front.tireWidthMm, front.aspect);
    this.hubY_R = tireOuterRadius(rear.rimInch, rear.tireWidthMm, rear.aspect);

    this.deckHeight = RATIO.deckHeight * L;

    // 车身升降：相对 OE 的轮心高差（Plus Sizing 守恒外径 → 通常为 0）
    const rAvg = (this.hubY_F + this.hubY_R) / 2;
    const rOeF = tireOuterRadius(OE_SPEC.front.rimInch, OE_SPEC.front.tireWidthMm, OE_SPEC.front.aspect);
    const rOeR = tireOuterRadius(OE_SPEC.rear.rimInch, OE_SPEC.rear.tireWidthMm, OE_SPEC.rear.aspect);
    const rOeAvg = (rOeF + rOeR) / 2;
    this.shellLift = this.shellLiftUser !== undefined && this.shellLiftUser !== null
      ? clamp(rAvg - rOeAvg, -0.06, 0.06) + this.shellLiftUser
      : clamp(rAvg - rOeAvg, -0.06, 0.06);

    this.recomputeDerived(front, rear);
    return this;
  }

  /**
   * 只重算「依赖轮胎尺寸的派生量」—— 改轮辋直径 / 胎宽 / 扁平比时调用，
   * 不动轴距 / 轮距（那些是底盘常量）。
   * @param {Object} front
   * @param {Object} rear
   */
  recomputeDerived(front, rear) {
    const tireHalfW_F = (front?.tireWidthMm ?? OE_SPEC.front.tireWidthMm) / 2000;
    const tireHalfW_R = (rear?.tireWidthMm ?? OE_SPEC.rear.tireWidthMm) / 2000;
    const bhw = this.bodyHalfWidth;

    this.clipZ = bhw + CLIP_CLEARANCE;
    this.clipTopY = RATIO.clipTopY * this.carLength;

    this.archR_F = this.hubY_F + ARCH_CLEARANCE;
    this.archR_R = this.hubY_R + ARCH_CLEARANCE;
    this.archInnerZ_F = Math.max(0.05, this.halfTrack_F - tireHalfW_F - ARCH_INNER_CLEARANCE);
    this.archInnerZ_R = Math.max(0.05, this.halfTrack_R - tireHalfW_R - ARCH_INNER_CLEARANCE);

    const trackAvg = (this.halfTrack_F + this.halfTrack_R) / 2;
    this.railHalfZ = Math.max(0.1, trackAvg - 0.1);
    this.floorHalfZ = Math.max(0.08, trackAvg - 0.16);

    this.linerR_F = Math.max(0.05, this.archR_F - 0.005);
    this.linerR_R = Math.max(0.05, this.archR_R - 0.005);

    this.skirtH = Math.max(0.02, this.deckHeight - this.rideHeight + 0.02);
    this.discR = Math.min(0.175, Math.max(0.08, ((this.hubY_F + this.hubY_R) / 2) * 0.52));
    return this;
  }

  /** 供面板覆盖后统一做一次合法性夹取 */
  clampAll() {
    const L = this.carLength;
    const bhw = this.bodyHalfWidth;
    this.wheelbase = clamp(this.wheelbase, 0.45 * L, 0.68 * L);
    // 实测轴位置不套对称 clamp（理由同 derive() Step 4），只挡车身外的荒谬值
    if (this.axleXMeasured) {
      if (!(this.axleX_F > this.axleX_R && this.axleX_F < 0.5 * L && this.axleX_R > -0.5 * L)) {
        this.axleX_F = clamp(this.axleX_F, 0.15 * L, 0.40 * L);
        this.axleX_R = clamp(this.axleX_R, -0.40 * L, -0.15 * L);
        this.axleXMeasured = false;
      }
    } else {
      this.axleX_F = clamp(this.axleX_F, 0.15 * L, 0.40 * L);
      this.axleX_R = clamp(this.axleX_R, -0.40 * L, -0.15 * L);
    }
    this.halfTrack_F = clamp(Math.max(0.3, this.halfTrack_F), 0.62 * bhw, 0.95 * bhw);
    this.halfTrack_R = clamp(Math.max(0.3, this.halfTrack_R), 0.62 * bhw, 0.95 * bhw);
    this.rideHeight = clamp(this.rideHeight, 0.03, 0.4);
    this.deckHeight = clamp(this.deckHeight, 0.06, 0.9);
    this.shellLift = clamp(this.shellLift, -0.12, 0.12);
    return this;
  }

  /**
   * @returns {{frontX:number, rearX:number, halfTrackF:number, halfTrackR:number,
   *            bodyHalfWidth:number, hubY:Object, corners:Array<Object>}}
   */
  cornerSpec() {
    const F = { y: this.hubY_F, x: this.axleX_F, t: this.halfTrack_F };
    const R = { y: this.hubY_R, x: this.axleX_R, t: this.halfTrack_R };
    return {
      frontX: F.x,
      rearX: R.x,
      halfTrackF: F.t,
      halfTrackR: R.t,
      bodyHalfWidth: this.bodyHalfWidth,
      hubY: { front: F.y, rear: R.y },
      corners: [
        { id: 'FL', label: '左前', x: F.x, y: F.y, z: +F.t, side: +1, halfTrack: F.t },
        { id: 'FR', label: '右前', x: F.x, y: F.y, z: -F.t, side: -1, halfTrack: F.t },
        { id: 'RL', label: '左后', x: R.x, y: R.y, z: +R.t, side: +1, halfTrack: R.t },
        { id: 'RR', label: '右后', x: R.x, y: R.y, z: -R.t, side: -1, halfTrack: R.t },
      ],
    };
  }

  /**
   * @returns {{deckHeight:number, clipZ:number, clipTopY:number, arches:Array<Object>}}
   */
  cutPlan() {
    const arch = (x, y, r, innerZ) => ({ axleX: x, hubY: y, radius: r, innerZ });
    return {
      deckHeight: this.deckHeight,
      clipZ: this.clipZ,
      clipTopY: this.clipTopY,
      arches: [
        arch(this.axleX_F, this.hubY_F, this.archR_F, this.archInnerZ_F),
        arch(this.axleX_F, this.hubY_F, this.archR_F, this.archInnerZ_F),
        arch(this.axleX_R, this.hubY_R, this.archR_R, this.archInnerZ_R),
        arch(this.axleX_R, this.hubY_R, this.archR_R, this.archInnerZ_R),
      ],
    };
  }
}

/* ------------------------------------------------------------------ */
/*                          底盘几何                                    */
/* ------------------------------------------------------------------ */

export class Chassis {
  /**
   * @param {THREE.Object3D} parent 挂到哪里（viewer.scene）
   */
  constructor(parent) {
    this.parent = parent;
    this.root = new THREE.Group();
    this.root.name = 'chassis';
    parent?.add?.(this.root);

    /** @type {ChassisParams} */
    this.p = new ChassisParams();
    /** @type {Object|null} */
    this.metrics = null;
    /** @type {{front:Object, rear:Object}|null} */
    this.axleParams = null;
    /** 是否已完成 derive（rideHeight 等主参数是否已算出）。面板据此判断是否跳过红字误报。 */
    this.derived = false;
    this.visible = true;

    /** @type {THREE.Mesh[]} */
    this.parts = [];
    /** @type {THREE.Material[]} */
    this.mats = [];
    this._mats = null;
    this._built = false;

    /** 悬挂降低量 Δ（mm），>0 车身降低。默认 0（贴地）。 */
    this.suspensionDeltaMm = 0;
  }

  /**
   * @param {Object} metrics ShellMeasure.measure()
   * @param {{front:Object, rear:Object}} axleParams
   * @param {{wheelbase?:number,halfTrack_F?:number,halfTrack_R?:number,rideHeight?:number}} [real] 真实车型参数（米）
   * @returns {ChassisParams}
   */
  derive(metrics, axleParams, real) {
    this.metrics = metrics;
    this.axleParams = axleParams;
    this.p = new ChassisParams({
      carLength: metrics.lengthNorm ?? this.p.carLength,
      shellLiftUser: this.p.shellLiftUser,
    }).derive(metrics, axleParams, real);
    this.derived = true;
    return this.p;
  }

  /**
   * 只更新依赖轮胎尺寸的部分（改轮辋直径 / 胎宽 / 扁平比）。
   *
   * ET / J / 倾角**不会**改变这里的任何量 → 签名不变 → 直接返回，不重建几何。
   * 这是「拖 ET/J/倾角不触发重切」这条性能契约的底盘侧保证。
   *
   * @param {{front:Object, rear:Object}} [axleParams]
   * @returns {ChassisParams}
   */
  update(axleParams) {
    if (axleParams) this.axleParams = axleParams;
    const f = this.axleParams?.front || OE_SPEC.front;
    const r = this.axleParams?.rear || OE_SPEC.rear;
    this.p.hubY_F = tireOuterRadius(f.rimInch, f.tireWidthMm, f.aspect);
    this.p.hubY_R = tireOuterRadius(r.rimInch, r.tireWidthMm, r.aspect);
    this.p.recomputeDerived(f, r);

    // 只有影响几何的量变了才重建
    const sig = [
      this.p.hubY_F, this.p.hubY_R, this.p.archR_F, this.p.archR_R,
      this.p.archInnerZ_F, this.p.archInnerZ_R, this.p.deckHeight,
      this.p.rideHeight, this.p.halfTrack_F, this.p.halfTrack_R,
      this.p.axleX_F, this.p.axleX_R, this.p.clipZ,
    ].map((v) => v.toFixed(6)).join('|');
    if (sig === this._buildSig) return this.p;
    this._buildSig = sig;

    if (this._built) this.build();
    return this.p;
  }

  /* ---------------- 材质 ---------------- */

  _materials() {
    if (this._mats) return this._mats;
    const mk = (s) =>
      new THREE.MeshStandardMaterial({
        color: s.color,
        metalness: s.metalness,
        roughness: s.roughness,
        envMapIntensity: s.envMapIntensity,
      });
    const m = {
      struct: mk(MAT_SPEC.struct),
      disc: mk(MAT_SPEC.disc),
      liner: mk(MAT_SPEC.liner),
      caliper: mk(MAT_SPEC.caliper),
    };
    m.liner.side = THREE.BackSide;
    this._mats = m;
    this.mats = Object.values(m);
    return m;
  }

  /* ---------------- 小工具 ---------------- */

  _clear() {
    for (const mesh of this.parts) {
      this.root.remove(mesh);
      mesh.geometry?.dispose?.();
    }
    this.parts = [];
  }

  /**
   * 加一个盒子。
   * @param {number[]} size [x,y,z]
   * @param {number[]} pos
   * @param {THREE.Material} mat
   * @param {{rx?:number, ry?:number, rz?:number}} [rot]
   */
  _box(size, pos, mat, rot) {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const m = new THREE.Mesh(g, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot.rx || 0, rot.ry || 0, rot.rz || 0);
    m.castShadow = false;
    m.receiveShadow = true;
    this.root.add(m);
    this.parts.push(m);
    return m;
  }

  /**
   * 加一个圆柱（默认轴向 Z）。
   * @param {number} r
   * @param {number} len
   * @param {number[]} pos
   * @param {THREE.Material} mat
   * @param {{segments?:number, open?:boolean, axis?:'x'|'y'|'z'}} opt
   */
  _cyl(r, len, pos, mat, opt = {}) {
    const g = new THREE.CylinderGeometry(r, r, len, opt.segments ?? 20, 1, !!opt.open);
    if (opt.axis === 'x') g.rotateZ(Math.PI / 2);
    else if (opt.axis === 'z') g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    if (opt.shadow === false) {
      m.castShadow = false;
      m.receiveShadow = false;
    } else {
      m.castShadow = false;
      m.receiveShadow = true;
    }
    this.root.add(m);
    this.parts.push(m);
    return m;
  }

  /* ---------------- 构建 ---------------- */

  /** 按当前参数重建全部底盘几何 */
  build() {
    const p = this.p;
    const M = this._materials();
    this._clear();

    const L = p.carLength;
    const xMin = -L / 2;
    const bodyHalf = p.bodyHalfWidth;

    /* --- 地板 / 承台：顶面略低于甲板高，避免从切口穿出来 --- */
    this._box(
      [L * 0.86, p.floorT, p.floorHalfZ * 2],
      [0, p.rideHeight + p.floorT / 2, 0],
      M.struct
    );

    /* --- 纵梁（左右） --- */
    for (const s of [1, -1]) {
      this._box([L * 0.86, 0.1, 0.08], [0, p.rideHeight + 0.05, s * p.railHalfZ], M.struct);
    }

    /* --- 前后副车架 --- */
    this._box([0.34, 0.08, p.railHalfZ * 2], [p.axleX_F, p.rideHeight + 0.06, 0], M.struct);
    this._box([0.34, 0.08, p.railHalfZ * 2], [p.axleX_R, p.rideHeight + 0.06, 0], M.struct);

    /* --- 前后保险杠横梁 + 下护板 ---
       车壳前部 x>0.77 且 y<0.38 完全没有几何体（设计 §1.3 证据 C），
       没有护板的话正前低机位会直接看穿到地面。 */
    this._box([0.1, 0.12, bodyHalf * 1.6], [L / 2 - 0.06, p.rideHeight + 0.08, 0], M.struct);
    this._box([0.14, 0.06, bodyHalf * 1.4], [L / 2 - 0.12, p.rideHeight + 0.03, 0], M.struct);
    this._box([0.1, 0.12, bodyHalf * 1.6], [-(L / 2 - 0.06), p.rideHeight + 0.08, 0], M.struct);
    this._box([0.14, 0.06, bodyHalf * 1.4], [-(L / 2 - 0.12), p.rideHeight + 0.03, 0], M.struct);

    /* --- 传动轴（轴 X） --- */
    this._cyl(0.03, p.wheelbase * 0.8, [0, p.rideHeight + 0.14, 0], M.struct, {
      segments: 12,
      axis: 'x',
    });

    /* --- 四角：轮毂座 / 刹车盘 / 卡钳 / 摆臂 / 弹簧座 / 轮拱内衬 --- */
    const corners = [
      { id: 'FL', x: p.axleX_F, y: p.hubY_F, t: p.halfTrack_F, r: p.archR_F, inner: p.archInnerZ_F, lr: p.linerR_F, side: +1 },
      { id: 'FR', x: p.axleX_F, y: p.hubY_F, t: p.halfTrack_F, r: p.archR_F, inner: p.archInnerZ_F, lr: p.linerR_F, side: -1 },
      { id: 'RL', x: p.axleX_R, y: p.hubY_R, t: p.halfTrack_R, r: p.archR_R, inner: p.archInnerZ_R, lr: p.linerR_R, side: +1 },
      { id: 'RR', x: p.axleX_R, y: p.hubY_R, t: p.halfTrack_R, r: p.archR_R, inner: p.archInnerZ_R, lr: p.linerR_R, side: -1 },
    ];

    for (const c of corners) {
      const s = c.side;

      // 轮毂座 / 转向节
      this._cyl(0.062, 0.1, [c.x, c.y, s * (c.t + 0.01)], M.struct, { segments: 20, axis: 'z' });

      // 刹车盘
      this._cyl(p.discR, 0.03, [c.x, c.y, s * (c.t - 0.025)], M.disc, { segments: 32, axis: 'z' });

      // 刹车卡钳
      this._box([0.05, 0.16, 0.07], [c.x - 0.02, c.y + p.discR * 0.75, s * (c.t - 0.025)], M.caliper);

      // 上 / 下摆臂：从纵梁斜拉到轮毂座
      for (const [dy, tilt] of [[0.085, 0.16], [-0.075, -0.16]]) {
        const len = Math.max(0.1, c.t - p.railHalfZ + 0.06);
        this._box(
          [0.07, 0.035, len],
          [c.x, c.y + dy, s * (p.railHalfZ + len / 2)],
          M.struct,
          { rx: tilt }
        );
      }

      // 减震弹簧座
      this._cyl(0.045, 0.14, [c.x, c.y + 0.17, s * (c.t - 0.06)], M.struct, { segments: 16, axis: 'y' });

      // 轮拱内衬：开口圆柱，BackSide，从内侧看是一圈暗腔
      const linerInnerZ = c.inner + 0.005;
      const linerOuterZ = p.clipZ;
      const linerLen = Math.max(0.02, linerOuterZ - linerInnerZ);
      this._cyl(c.lr, linerLen, [c.x, c.y, s * (linerInnerZ + linerLen / 2)], M.liner, {
        segments: 36,
        open: true,
        axis: 'z',
        shadow: false,
      });

      // 内衬端盖（堵住内侧端）
      const ring = new THREE.RingGeometry(c.lr * 0.35, c.lr, 36);
      const cap = new THREE.Mesh(ring, M.liner);
      cap.position.set(c.x, c.y, s * (linerInnerZ + 0.002));
      if (s < 0) cap.rotation.y = Math.PI; // 法线朝外
      cap.castShadow = false;
      cap.receiveShadow = false;
      this.root.add(cap);
      this.parts.push(cap);
    }

    /* --- 分段裙板（24 段 × 左右） ---
       车壳切口半宽沿 x 剧烈变化（本车 0.615 → 1.008 → 0），
       直裙板必然露缝或外凸，因此按 cutEdgeProfile 自适应。 */
    const N = 24;
    const profile = this.metrics?.cutEdgeProfile;
    const outerXLo = p.axleX_R + p.archR_R + 0.05;
    const outerXHi = p.axleX_F - p.archR_F - 0.05;
    const segW = L / N + 0.002;
    const depth = 0.03;
    const yC = (p.deckHeight + p.rideHeight) / 2;

    for (const s of [1, -1]) {
      for (let i = 0; i < N; i++) {
        const xi = xMin + (i + 0.5) * (L / N);
        let halfZ;
        if (xi >= outerXLo && xi <= outerXHi && profile && Number.isFinite(profile[i])) {
          // 两轴之间：贴着车壳切口走（外表面内缩 12mm，形成接缝阴影线）
          halfZ = Math.min(profile[i], p.clipZ);
        } else {
          // 前后悬段：收窄到地板半宽，避免裙板横穿轮拱
          halfZ = Math.min(p.floorHalfZ, p.clipZ);
        }
        if (halfZ <= 0.02) continue;
        this._box([segW, p.skirtH, depth], [xi, yC, s * (halfZ - 0.012 - depth / 2)], M.struct);
      }
    }

    this._built = true;
    this.root.visible = this.visible;
    return this;
  }

  /* ---------------- 输出 ---------------- */

  cornerSpec() {
    return this.p.cornerSpec();
  }

  cutPlan() {
    return this.p.cutPlan();
  }

  /* ---------------- 悬挂（车身相对车轮下移 Δ） ---------------- */

  /**
   * 设置悬挂高度偏移。只移动 chassis.root 的 y 偏移，**不重建几何**。
   * 车轮 rig 不受影响；车身相对车轮整体升降 + 平均分角升降。
   * @param {number} deltaMm Δ>0 表示车身降低（全局）
   * @param {number} bodyLiftMm 分角/分轴悬挂的平均升降量（mm），正值升高
   */
  setSuspension(deltaMm = 0, bodyLiftMm = 0) {
    this.suspensionDeltaMm = Number(deltaMm) || 0;
    this.root.position.y = -this.suspensionDeltaMm / 1000 + (Number(bodyLiftMm) || 0) / 1000;
  }

  /**
   * 计算悬挂读数（前端读数的唯一入口，面板不得自行算）。
   * 基准量来自当前底盘参数：基准离地 = rideHeight、基准轮拱 = ARCH_CLEARANCE。
   *
   * ⚠️ 尚未 derive 时 rideHeight 为 0，baseGroundClearanceMm 随之 0。
   *    本函数仍返回结构完整（全 0）的占位对象，但调用方（panel.updateReadout）
   *    必须以 `chassis.derived` / `rideHeight > 0` 判定是否展示，禁止据此着 danger 红。
   * @returns {{groundClearance:number, fenderGap:number, wheelExposureRatio:number, deltaMm:number, tireDiameterMm:number}}
   */
  suspensionReadout() {
    const baseGC = (this.p.rideHeight || 0) * 1000;
    const baseFG = ARCH_CLEARANCE * 1000;
    const r = computeSuspensionReadout({
      baseGroundClearanceMm: baseGC,
      baseFenderGapMm: baseFG,
      deltaMm: this.suspensionDeltaMm,
    });
    const avgHubY =
      this.p.hubY_F && this.p.hubY_R ? (this.p.hubY_F + this.p.hubY_R) / 2 : 0;
    return { ...r, deltaMm: this.suspensionDeltaMm, tireDiameterMm: avgHubY * 2000 };
  }

  /* ---------------- 其它 ---------------- */

  setVisible(on) {
    this.visible = !!on;
    this.root.visible = this.visible;
  }

  /** 底盘三角面数（自检用） */
  triCount() {
    let n = 0;
    for (const m of this.parts) {
      const g = m.geometry;
      if (!g) continue;
      n += g.index ? Math.floor(g.index.count / 3) : Math.floor(g.attributes.position.count / 3);
    }
    return n;
  }

  dispose() {
    this._clear();
    for (const m of Object.values(this._mats || {})) m?.dispose?.();
    this._mats = null;
    this.mats = [];
    this.root.removeFromParent();
    this._built = false;
  }
}
