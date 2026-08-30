/**
 * shellCutter.js — 车壳三道切割
 *
 * 背景：图生 3D 的车壳是**单网格、单材质**的贴图外壳，车轮是画在 baseColor 上的，
 * 没有任何几何体（实测前轴区域 y<0.35 面数为 0）。所以「挖掉原车轮」在几何上
 * 不成立 —— 正确做法是**给底盘的轮子让出开口**，并把画着轮子的那块贴图切掉。
 *
 * 三道谓词（**并集**：满足任意一条即移除该三角形）：
 *
 *   C1 底切   y < deckHeight
 *            切掉车底楔形伪影 + 贴图轮子的下半截
 *   C2 侧切   |z| > clipZ && y < clipTopY
 *            切掉比车身侧面更外凸的伪影。本车最宽 |z|=1.045 出现在
 *            y∈[0.35,0.50] 的**纵向中央底部**而不是轮拱 —— C1 只切到 0.30，
 *            够不着 0.30~0.50 那一段；抬高 deckHeight 能解决但车壳会变浴缸。
 *            C2 用 0.72% 的面数代价解决，最省。
 *   C3 轮拱   |z| > archInnerZ && hypot(x - axleX, y - hubY) < radius
 *            开出四个轮拱，让底盘轮子露出来，同时切掉贴图轮子。
 *
 * **三道切割只依赖底盘给出的 axleX / halfTrack，不依赖任何车轮探测** —— 这是它可靠的根本原因。
 *
 * 实现要点：
 *   · 只改索引不动顶点（沿用 wheelCutout.js 的思路，但独立实现，不继承）
 *   · 切割后把材质切成 DoubleSide：C1 之后车壳是朝下开口的壳，
 *     从正侧 / 45° 低机位必然看到内部，FrontSide 会直接看穿到环境贴图
 *   · `_key` 缓存：ET / J / 倾角变化不得改变 plan 序列化结果，避免拖滑杆时重建
 */

import * as THREE from 'three';
import { ensureIndex } from './shellMeasure.js';

/** 默认参数（架构师实测值，见 docs/increment-DESIGN-shell-chassis.md §4.2） */
export const SHELL_DEFAULTS = {
  deckHeight: 0.3, // C1 底切高度 = 底盘甲板高
  clipZ: 0.9449, // C2 侧向裁剪阈值 = bodyHalfWidth + 0.015
  clipTopY: 0.55, // C2 只对下半身生效
  enableC1: true,
  enableC2: true,
  enableC3: true,
  doubleSide: true, // 切后转双面
};

export class ShellCutter {
  constructor() {
    /** @type {Array<any>} */
    this.entries = [];
    this.removedTris = 0;
    this.totalTris = 0;
    /** 重建次数，供测试断言 _key 缓存是否命中 */
    this.buildCount = 0;
    this._key = '';
    /** @type {Map<THREE.Material, number>} 材质原始 side，restore 时还原 */
    this._origSide = new Map();
  }

  /**
   * 接管一棵子树下的所有网格。必须在归一 / 测量之后调用，
   * 这样缓存下来的世界坐标才是最终坐标。
   * @param {THREE.Object3D} root
   * @returns {number} 接管的网格数
   */
  capture(root) {
    this.release();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const geo = o.geometry;
      const orig = ensureIndex(geo);
      const work = new THREE.BufferAttribute(new Uint32Array(orig.count), 1);
      work.array.set(orig.array);
      geo.setIndex(work);

      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && !this._origSide.has(m)) this._origSide.set(m, m.side);
      }

      this.entries.push({
        mesh: o,
        geo,
        orig,
        work,
        world: null,
        sphere: geo.boundingSphere ? geo.boundingSphere.clone() : null,
        box: geo.boundingBox ? geo.boundingBox.clone() : null,
      });
    });
    this.refresh();
    this.totalTris = this.entries.reduce((a, e) => a + Math.floor(e.orig.count / 3), 0);
    this.removedTris = 0;
    return this.entries.length;
  }

  /** 模型变换变了（转 90° / 改车长）→ 重算缓存的世界坐标 */
  refresh() {
    const v = new THREE.Vector3();
    for (const e of this.entries) {
      const pos = e.geo.attributes.position;
      const n = pos.count;
      if (!e.world || e.world.length !== n * 3) e.world = new Float32Array(n * 3);
      e.mesh.updateMatrixWorld(true);
      const m = e.mesh.matrixWorld;
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        e.world[i * 3] = v.x;
        e.world[i * 3 + 1] = v.y;
        e.world[i * 3 + 2] = v.z;
      }
    }
    this._key = ''; // 强制下次重建
  }

  /**
   * 生成三道切割的谓词。
   * @param {CutPlan} plan
   * @param {typeof SHELL_DEFAULTS} opt
   * @returns {(x:number, y:number, az:number) => boolean} true = 移除
   */
  static makeCutPredicate(plan, opt = {}) {
    const deckHeight = plan.deckHeight ?? opt.deckHeight ?? SHELL_DEFAULTS.deckHeight;
    const clipZ = plan.clipZ ?? opt.clipZ ?? SHELL_DEFAULTS.clipZ;
    const clipTopY = plan.clipTopY ?? opt.clipTopY ?? SHELL_DEFAULTS.clipTopY;
    const useC1 = plan.enableC1 ?? opt.enableC1 ?? SHELL_DEFAULTS.enableC1;
    const useC2 = plan.enableC2 ?? opt.enableC2 ?? SHELL_DEFAULTS.enableC2;
    const useC3 = plan.enableC3 ?? opt.enableC3 ?? SHELL_DEFAULTS.enableC3;

    const arches = (plan.arches || []).map((a) => ({
      axleX: a.axleX,
      hubY: a.hubY,
      r2: a.radius * a.radius,
      innerZ: a.innerZ,
    }));

    return function remove(x, y, az) {
      if (useC1 && y < deckHeight) return true;
      if (useC2 && az > clipZ && y < clipTopY) return true;
      if (useC3) {
        for (let i = 0; i < arches.length; i++) {
          const a = arches[i];
          if (az <= a.innerZ) continue;
          const dx = x - a.axleX;
          const dy = y - a.hubY;
          if (dx * dx + dy * dy < a.r2) return true;
        }
      }
      return false;
    };
  }

  /**
   * 执行三道切割。
   * @param {CutPlan} plan 来自 Chassis.cutPlan()
   * @param {Partial<typeof SHELL_DEFAULTS>} [opt]
   */
  apply(plan, opt = {}) {
    if (!this.entries.length) return;

    const deckHeight = plan.deckHeight ?? opt.deckHeight ?? SHELL_DEFAULTS.deckHeight;
    const clipZ = plan.clipZ ?? opt.clipZ ?? SHELL_DEFAULTS.clipZ;
    const clipTopY = plan.clipTopY ?? opt.clipTopY ?? SHELL_DEFAULTS.clipTopY;
    const archSig = (plan.arches || [])
      .map((a) => `${a.axleX.toFixed(5)},${a.hubY.toFixed(5)},${a.radius.toFixed(5)},${a.innerZ.toFixed(5)}`)
      .join(';');

    // 缓存键只由「切割形状」决定：ET / J / 倾角不进键 → 拖滑杆不重建
    const key =
      `${deckHeight.toFixed(5)}|${clipZ.toFixed(5)}|${clipTopY.toFixed(5)}|` +
      `${plan.enableC1 !== false ? 1 : 0}${plan.enableC2 !== false ? 1 : 0}${plan.enableC3 !== false ? 1 : 0}|` +
      `${archSig}`;
    if (key === this._key) return;
    this._key = key;
    this.buildCount++;

    const useDouble = opt.doubleSide ?? SHELL_DEFAULTS.doubleSide;
    const remove = ShellCutter.makeCutPredicate(plan, opt);

    let removed = 0;
    let total = 0;

    for (const e of this.entries) {
      const wp = e.world;
      const src = e.orig.array;
      const dst = e.work.array;
      const tris = Math.floor(src.length / 3);
      let n = 0;

      for (let t = 0; t < tris; t++) {
        const a = src[t * 3];
        const b = src[t * 3 + 1];
        const c = src[t * 3 + 2];

        const px = (wp[a * 3] + wp[b * 3] + wp[c * 3]) / 3;
        const py = (wp[a * 3 + 1] + wp[b * 3 + 1] + wp[c * 3 + 1]) / 3;
        const pz = (wp[a * 3 + 2] + wp[b * 3 + 2] + wp[c * 3 + 2]) / 3;

        if (remove(px, py, Math.abs(pz))) continue;

        dst[n++] = a;
        dst[n++] = b;
        dst[n++] = c;
      }

      // 尾部填退化三角形（三个相同索引），GPU 会直接丢弃，不用改 count
      for (let i = n; i < dst.length; i++) dst[i] = 0;

      e.work.needsUpdate = true;
      // 只删不增，原始包围球仍是超集，直接沿用，省一次 O(n) 计算
      if (e.sphere) e.geo.boundingSphere = e.sphere.clone();
      if (e.box) e.geo.boundingBox = e.box.clone();

      if (useDouble) {
        const mats = Array.isArray(e.mesh.material) ? e.mesh.material : [e.mesh.material];
        for (const m of mats) {
          if (!m) continue;
          if (!this._origSide.has(m)) this._origSide.set(m, m.side);
          if (m.side !== THREE.DoubleSide) {
            m.side = THREE.DoubleSide;
            m.needsUpdate = true;
          }
        }
      }

      removed += tris - n / 3;
      total += tris;
    }

    this.removedTris = removed;
    this.totalTris = total;
  }

  /** 还原成未切割状态（换回原始索引 + 原始 side） */
  restore() {
    for (const e of this.entries) {
      e.geo.setIndex(e.orig);
      if (e.sphere) e.geo.boundingSphere = e.sphere.clone();
      if (e.box) e.geo.boundingBox = e.box.clone();
    }
    for (const [mat, side] of this._origSide) {
      if (mat.side !== side) {
        mat.side = side;
        mat.needsUpdate = true;
      }
    }
    this._key = '';
    this.removedTris = 0;
  }

  /** 释放接管（不销毁几何，仅供换车时清理引用） */
  release() {
    for (const e of this.entries) e.geo.setIndex(e.orig);
    for (const [mat, side] of this._origSide) {
      if (mat.side !== side) {
        mat.side = side;
        mat.needsUpdate = true;
      }
    }
    this._origSide.clear();
    this.entries = [];
    this._key = '';
    this.removedTris = 0;
    this.totalTris = 0;
  }

  stats() {
    return {
      meshes: this.entries.length,
      totalTris: this.totalTris,
      removedTris: this.removedTris,
      keptTris: this.totalTris - this.removedTris,
      buildCount: this.buildCount,
    };
  }
}

/**
 * @typedef {Object} Arch
 * @property {number} axleX
 * @property {number} hubY
 * @property {number} radius
 * @property {number} innerZ
 */

/**
 * @typedef {Object} CutPlan
 * @property {number} deckHeight
 * @property {number} clipZ
 * @property {number} clipTopY
 * @property {Arch[]} arches
 * @property {boolean} [enableC1]
 * @property {boolean} [enableC2]
 * @property {boolean} [enableC3]
 */
