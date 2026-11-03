/**
 * wheelFit.js — 轮位规格与适配读数
 *
 * 车壳 / 底盘分层之后（见 docs/increment-DESIGN-shell-chassis.md）：
 *   · 轮位真值来自 Chassis.cornerSpec()，**不再从这里探测**（第 1 层的 detectWheelCenters 已废弃）
 *   · 本模块收敛为「纯函数层」：轮位规格转换 + Plus Sizing 派生 + 齐平度报告
 *
 * 保留 detectWheelCenters / autoDetectCorners 的导出：
 *   scripts/_measure-wheel.mjs、_diag-cut.mjs、_qa-edge-tire.mjs、_repro-tire.mjs、
 *   dryrun.mjs、render.mjs 都还在调用，不能删。
 */

import * as THREE from 'three';

/** 轮辋直径 +1 inch 时扁平比的变化量（PRD §5.2 规则 A） */
export const ASPECT_PER_INCH = 5;

/**
 * Plus Sizing：同胎宽下，轮辋直径 +1 inch ⇒ 扁平比 −5，clamp[25, 50]。
 *
 *   plusSizeAspect(35, +1) = 30
 *   plusSizeAspect(30, +1) = 25
 *   plusSizeAspect(25, +1) = 25   ← 触底
 *
 * @param {number} aspectOld 当前扁平比
 * @param {number} deltaInch 轮辋直径变化量（+1 / −1 …）
 * @param {{min?:number, max?:number}} [opt]
 * @returns {number}
 */
export function plusSizeAspect(aspectOld, deltaInch, opt = {}) {
  const min = opt.min ?? 25;
  const max = opt.max ?? 50;
  return Math.min(max, Math.max(min, Math.round(aspectOld - ASPECT_PER_INCH * deltaInch)));
}

/**
 * J ↔ 胎宽比值：PRD §1.4 分区判据。
 * ratio = tireWidthMm / (j × 25.4)
 * @param {number} tireWidthMm
 * @param {number} j
 * @returns {number}
 */
export function jTireRatio(tireWidthMm, j) {
  const w = j * 25.4;
  if (!(w > 0)) return NaN;
  return tireWidthMm / w;
}

/**
 * 【已废弃】从归一化后的整车网格探测四轮中心。
 *
 * 废弃原因：图生 3D 的车壳里**没有车轮几何体**（my-car.glb 前轴区域 y<0.35 面数为 0，
 * 车轮是画在 baseColor 上的）。本函数抓到的是「车身下半侧板的质心」，
 * 实测给出轮半径 0.726m = 轮径 1.45m，比整车高度 1.36m 还大 —— 几何上不可能。
 *
 * 保留理由：scripts/_measure-wheel.mjs、_diag-cut.mjs 仍在调用，作为**反面证据**留存。
 * 产品代码（main.js）已不再调用它。
 *
 * 本次顺带修掉一个越界隐患（设计 §6.2）：
 *   非索引几何且 `pos.count % 3 !== 0` 时，末次 `vi = t*3+2` 会越界读 undefined，
 *   NaN 会污染后续所有均值 / 半径，而 autoFitCorners 的 Number.isFinite 检查会静默回退，
 *   极难排查。这里加 Math.floor + 上界检查。
 *
 * @deprecated 轮位真值请用 Chassis.cornerSpec()
 * @param {THREE.Object3D} carGroup
 * @param {THREE.Vector3} size
 * @returns {Object|null}
 */
export function detectWheelCenters(carGroup, size) {
  if (!carGroup || !size) return null;

  const meshes = [];
  carGroup.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  if (!meshes.length) return null;

  const H = size.y;
  const L = size.x;
  const V = new THREE.Vector3();
  const tri = [];

  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index;
    const m = mesh.matrixWorld;
    // 索引安全：Math.floor + 上界检查（设计 §11 共享约定）
    const count = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
    for (let t = 0; t < count; t++) {
      let x = 0;
      let y = 0;
      let z = 0;
      let valid = true;
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.array[t * 3 + k] : t * 3 + k;
        if (!(vi >= 0 && vi < pos.count)) { valid = false; break; }
        V.fromBufferAttribute(pos, vi).applyMatrix4(m);
        x += V.x; y += V.y; z += V.z;
      }
      if (!valid) continue; // 越界三角形整体丢弃，绝不把 NaN 带进后面的均值
      tri.push({ x: x / 3, y: y / 3, z: z / 3 });
    }
  }

  function corner(xSign, zSign) {
    const xs = [], ys = [], zs = [];
    const xDead = L * 0.06;
    const zThresh = size.z * 0.12;
    for (const t of tri) {
      if (t.y > 0.58 * H) continue;
      if (xSign > 0 ? t.x < xDead : t.x > -xDead) continue;
      if (zSign > 0 ? t.z < zThresh : t.z > -zThresh) continue;
      xs.push(t.x); ys.push(t.y); zs.push(Math.abs(t.z));
    }
    if (xs.length < 30) return null;

    let cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    let cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    let cz = zs.reduce((a, b) => a + b, 0) / zs.length;

    for (let it = 0; it < 3; it++) {
      const nx = [], ny = [], nz = [];
      for (let i = 0; i < xs.length; i++) {
        if (Math.hypot(xs[i] - cx, zs[i] - cz) < 0.5) {
          nx.push(xs[i]); ny.push(ys[i]); nz.push(zs[i]);
        }
      }
      if (!nx.length) break;
      cx = nx.reduce((a, b) => a + b, 0) / nx.length;
      cy = ny.reduce((a, b) => a + b, 0) / ny.length;
      cz = nz.reduce((a, b) => a + b, 0) / nz.length;
    }

    const inCyl = [];
    for (let i = 0; i < xs.length; i++) {
      if (Math.hypot(xs[i] - cx, zs[i] - cz) < 0.5) inCyl.push(ys[i]);
    }
    inCyl.sort((a, b) => a - b);
    const topY = inCyl.length ? inCyl[Math.floor(inCyl.length * 0.85)] : cy;
    const r = Math.min(Math.max(topY * 0.48, 0.25), 0.45);

    return { x: cx, y: cy, z: zSign > 0 ? cz : -cz, r };
  }

  const FL = corner(1, 1);
  const FR = corner(1, -1);
  const RL = corner(-1, 1);
  const RR = corner(-1, -1);
  if (!FL || !FR || !RL || !RR) return null;

  return {
    frontX: (FL.x + FR.x) / 2,
    rearX: (RL.x + RR.x) / 2,
    halfTrackF: (Math.abs(FL.z) + Math.abs(FR.z)) / 2,
    halfTrackR: (Math.abs(RL.z) + Math.abs(RR.z)) / 2,
    radius: (FL.r + FR.r + RL.r + RR.r) / 4,
    raw: { FL, FR, RL, RR },
  };
}

/**
 * 把轮位规格转成四个角的 {id,label,x,z,side}。
 *
 * 优先级：
 *   1) spec.corners —— 底盘直接给出的四角（新架构的主路径）
 *   2) spec.frontX / rearX / halfTrackF / halfTrackR —— 兼容旧形状
 *      （_qa-edge-tire.mjs 就是这么调 setDetectedCorners 的，形状不能变）
 *   3) carSize 经验比例 —— 兜底，正常走不到
 *
 * @param {{carSize?:THREE.Vector3, rimWidth?:number, detected?:Object, spec?:Object}} args
 * @returns {Array<{id:string,label:string,x:number,z:number,side:number}>}
 */
export function autoFitCorners(args = {}) {
  const spec = args.spec || args.detected || null;
  const carSize = args.carSize;
  const rimWidth = args.rimWidth ?? 0.216;
  const L = carSize?.x ?? 4.6;
  const W = carSize?.z ?? 1.86;

  // ① 底盘直接给了四角
  if (spec?.corners?.length === 4) {
    return spec.corners.map((c) => ({
      id: c.id,
      label: c.label || c.id,
      x: c.x,
      z: c.z,
      side: c.side,
    }));
  }

  let frontX;
  let rearX;
  let halfTrackF;
  let halfTrackR;
  if (spec && Number.isFinite(spec.frontX) && Number.isFinite(spec.rearX)) {
    // ② 旧形状（/ 底盘的 cornerSpec 老字段）
    frontX = spec.frontX;
    rearX = spec.rearX;
    halfTrackF = Math.max(0.3, spec.halfTrackF);
    halfTrackR = Math.max(0.3, spec.halfTrackR);
  } else {
    // ③ 兜底
    frontX = L / 2 - L * 0.215;
    rearX = -(L / 2 - L * 0.245);
    halfTrackF = halfTrackR = Math.max(0.35, W / 2 - rimWidth / 2 - 0.008);
  }

  return [
    { id: 'FL', label: '左前', x: frontX, z: +halfTrackF, side: +1 },
    { id: 'FR', label: '右前', x: frontX, z: -halfTrackF, side: -1 },
    { id: 'RL', label: '左后', x: rearX, z: +halfTrackR, side: +1 },
    { id: 'RR', label: '右后', x: rearX, z: -halfTrackR, side: -1 },
  ];
}

/**
 * 齐平度读数（PRD §4.6 / 设计 §5.3(4)）。
 *
 * 三处与旧版的实质差异：
 *   1) **基准换成轮胎胎侧外缘**，不再是轮辋外缘（PRD C6）
 *   2) **计入倾角**：胎侧顶部随倾角内移 `OD/2 × sin(θ)`（PRD C7）
 *   3) **bodyHalfWidth 来自 ShellMeasure 的分位数**，不再用 `carSize.z / 2`
 *      （旧值被车底伪影撑大 114mm，会淹没 ±5mm 的 Flush 区间 —— PRD 未列出的隐藏冲突）
 *
 * 另外：Δouter 的基准是 **OE_ET / OE_J**（R230 原厂），
 * 与「车轮 3D 位置」用的 ET_REF = 42（几何零点，测试锁死）**分工不同，不可混用**。
 *
 * @param {Object} a
 * @param {number} a.halfTrack   底盘几何轮距半（米）
 * @param {number} a.et
 * @param {number} a.j
 * @param {number} a.oeEt        本轴 OE 偏距（前 30 / 后 31）
 * @param {number} a.oeJ         本轴 OE 轮辋宽（前 8.5 / 后 9.5）
 * @param {number} a.tireWidthMm
 * @param {number} a.odMm        轮胎外径（mm）
 * @param {number} a.camberDeg   倾角（负 = 内八）
 * @param {number} a.bodyHalfWidth 来自 ShellMeasure（米）
 * @param {number} [a.fenderOffset] 翼子板基准补偿（mm）
 * @returns {{dOuterMm:number, etOffsetMm:number, sidewallOuterMm:number, flushMm:number, verdict:Object}}
 */
export function fitmentReport({
  halfTrack,
  et,
  j,
  oeEt,
  oeJ,
  tireWidthMm,
  odMm,
  camberDeg,
  bodyHalfWidth,
  fenderOffset = 0,
}) {
  // Δouter：相对原厂的外移量（mm），正 = 往外
  const dOuter = ((j * 25.4) / 2 - et) - ((oeJ * 25.4) / 2 - oeEt);

  // 胎侧外缘：轮距 + 外移 + 半个胎宽的水平投影 − 倾角导致的顶部内移
  const th = Math.abs((camberDeg || 0) * Math.PI) / 180;
  const sidewallOuter =
    halfTrack * 1000 + dOuter + (tireWidthMm / 2) * Math.cos(th) - (odMm / 2) * Math.sin(th);

  const flushMm = sidewallOuter - bodyHalfWidth * 1000 - fenderOffset;

  let verdict;
  if (flushMm > 12) verdict = { text: '外凸 Poke', level: 'warn' };
  else if (flushMm > 5) verdict = { text: '轻微外凸 Mild Poke', level: 'warn' };
  else if (flushMm >= -5) verdict = { text: '齐平 Flush', level: 'good' };
  else if (flushMm >= -18) verdict = { text: '轻微内凹 Mild Tuck', level: 'ok' };
  else if (flushMm >= -35) verdict = { text: '内凹 Tuck', level: 'ok' };
  else verdict = { text: '过度内凹 Sunken', level: 'warn' };

  return {
    dOuterMm: dOuter,
    etOffsetMm: dOuter,
    sidewallOuterMm: sidewallOuter,
    flushMm,
    verdict,
  };
}
