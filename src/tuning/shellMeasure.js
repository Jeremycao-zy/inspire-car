/**
 * shellMeasure.js — 车壳测量
 *
 * 为什么需要它：图生 3D 的车壳包围盒**不可信**。
 * 实测 my-car.glb 归一化后包围盒宽 2.089m，但那是被车底中央一条重建伪影
 * （|z| 最大 1.045，出现在 y∈[0.35,0.50]、x∈[0.0,0.45]）撑大的。
 * 真实车身半宽只有 0.930m（车身宽 1.860m）。
 *
 * 任何用 `carSize.z / 2` 当车身半宽的计算都会偏大 114mm
 * —— 这足以淹没 ±5mm 的 Flush 判定区间。
 *
 * 本模块只做两件事，都是纯几何统计，不含任何车轮语义：
 *   1) bodyHalfWidth  —— 在「车身侧板高度带」内取 |z| 的高分位数
 *   2) cutEdgeProfile —— 沿车长采样底切高度处的切口半宽（供底盘裙板自适应）
 *
 * 全部导出为纯函数，可在 Node 里独立单测（不需要 WebGL）。
 *
 * 坐标约定：+X 车头 / +Y 上 / +Z 车身左侧；场景单位 = 米。
 */

import * as THREE from 'three';

/**
 * 车身侧板测量带的高度窗口，按**归一化车长 L** 归一。
 * L = 4.600 时 → y ∈ [0.60, 0.85] 米，正是设计 §1.4 分位数所用的窗口。
 */
export const BAND_LO = 0.1304;
export const BAND_HI = 0.1848;

/**
 * 把一棵 Object3D 下所有带索引的网格展平成「三角形重心数组」。
 *
 * 索引安全（共享约定）：
 *   · 先 ensureIndex()，非索引几何补顺序索引
 *   · 三角形数一律 Math.floor(count / 3)
 *   · 顶点下标做上界检查，越界的三角形整体丢弃（避免 NaN 污染后续分位数）
 *
 * @param {THREE.Object3D} root
 * @returns {{xs:Float64Array, ys:Float64Array, azs:Float64Array, n:number, box:THREE.Box3, meshes:number}}
 */
export function collectTriangles(root) {
  root.updateMatrixWorld(true);

  /** @type {Array<{geo: THREE.BufferGeometry, mesh: THREE.Mesh}>} */
  const list = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry?.attributes?.position) list.push({ geo: o.geometry, mesh: o });
  });

  // 先统计三角形总数，一次性分配
  let total = 0;
  const counts = [];
  for (const { geo } of list) {
    const idx = ensureIndex(geo);
    const c = Math.floor(idx.count / 3);
    counts.push(c);
    total += c;
  }

  const xs = new Float64Array(total);
  const ys = new Float64Array(total);
  const azs = new Float64Array(total);

  const v = new THREE.Vector3();
  const posOf = [];
  for (const { geo } of list) posOf.push(geo.attributes.position);

  let n = 0;
  list.forEach(({ geo, mesh }, mi) => {
    const pos = posOf[mi];
    const idx = geo.index;
    const vertCount = pos.count;
    const c = counts[mi];
    for (let t = 0; t < c; t++) {
      let x = 0;
      let y = 0;
      let z = 0;
      let valid = true;
      for (let k = 0; k < 3; k++) {
        const vi = idx.array[t * 3 + k];
        if (!(vi >= 0 && vi < vertCount)) { valid = false; break; } // 越界 → 整片丢弃
        v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        x += v.x; y += v.y; z += v.z;
      }
      if (!valid) continue;
      xs[n] = x / 3;
      ys[n] = y / 3;
      azs[n] = Math.abs(z / 3);
      n++;
    }
  });

  const box = new THREE.Box3();
  for (let i = 0; i < n; i++) {
    box.expandByPoint(new THREE.Vector3(xs[i], ys[i], azs[i]));
  }
  // |z| 丢掉了符号，这里用 z 的绝对值范围重建 z 轴
  box.min.z = -box.max.z;

  return { xs, ys, azs, n, box, meshes: list.length };
}

/**
 * 保证几何体带索引（非索引几何补一个顺序索引，方便统一处理）。
 * 与 wheelCutout.js:26 同一份逻辑，新代码一律先调它。
 *
 * @param {THREE.BufferGeometry} geo
 * @returns {THREE.BufferAttribute}
 */
export function ensureIndex(geo) {
  if (geo.index) return geo.index;
  const n = geo.attributes.position.count;
  const arr = new Uint32Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  const attr = new THREE.BufferAttribute(arr, 1);
  geo.setIndex(attr);
  return attr;
}

/**
 * 线性插值分位数（不修改入参，内部拷贝排序）。
 *
 * @param {Float64Array|number[]} src
 * @param {number} p 0~1
 * @returns {number} 空数组时返回 NaN
 */
export function percentile(src, p) {
  const n = src.length;
  if (!n) return NaN;
  const arr = Array.prototype.slice.call(src, 0, n);
  arr.sort((a, b) => a - b);
  if (n === 1) return arr[0];
  const q = Math.min(1, Math.max(0, p));
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

/**
 * 车身半宽：在车身侧板高度带内取 |z| 的高分位数。
 *
 * 测量带 y ∈ [BAND_LO × L, BAND_HI × L]（L = 归一化车长）。
 * 在 L = 4.600 时即 **y ∈ [0.60, 0.85] 米**。
 *
 * ⚠️ 设计文档 §3.2 Step 1 写的是「y ∈ [0.60 × H_norm, 0.85 × H_norm] → [0.816, 1.156]」，
 *    但那个窗口**复现不出**文档自己给出的分位数。实测四种口径：
 *
 *      A [0.60H, 0.85H] = [0.816, 1.156]  → p99.5 = 0.9201  max = 0.9239   ✗
 *      B [0.60,  0.85 ] 米               → p99.5 = 0.9299  max = 0.9355   ✅ 与文档完全吻合
 *      C [0.1304L, 0.1848L]              → p99.5 = 0.9299  max = 0.9355   ✅（B 的尺度无关写法）
 *      D [0.50H, 0.66H]  = [0.680, 0.898] → p99.5 = 0.9226  max = 0.9331   ✗
 *
 *    文档 §1.4 的 p99.5 = 0.9299 / p99.9 = 0.9339 / max = 0.9355 三项同时命中 B/C，
 *    且文档的判据原文「上界避开 y > 0.9 的车顶收缩区」也只有 B 满足（1.156 > 0.9，A 自相矛盾）。
 *    → 文档里的「× H_norm」是笔误，本实现按 B/C 口径，即用 **车长 L** 归一，尺度无关。
 *
 *    复现脚本见 scripts/_pct.mjs。
 *
 * 分位数用 p99.5 而不是 max：换车时后视镜可能落在这个高度带内；
 * 也不用 p98 —— 会被内饰面稀释（本车 p98 = 0.9205，比 p99.5 小 9.4mm）。
 *
 * @param {{ys:Float64Array, azs:Float64Array, n:number}} tris
 * @param {number} yLo 绝对高度下界
 * @param {number} yHi 绝对高度上界
 * @param {number} pct 分位数，默认 0.995
 * @returns {number} NaN 表示测量带内没有三角形
 */
export function bodyHalfWidth(tris, yLo, yHi, pct = 0.995) {
  const { ys, azs, n } = tris;
  const buf = [];
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (y < yLo || y > yHi) continue;
    buf.push(azs[i]);
  }
  if (!buf.length) return NaN;
  return percentile(buf, pct);
}

/**
 * 车壳底切处的切口半宽剖面（沿车长采样）。
 *
 * 每个采样窗口取窗口内 max|z|；窗口内没有三角形时回退到 `fallback`
 * （默认 `bodyHalfWidth × 0.82`）—— 本车前段 x>0.77 且 y<0.38 完全没有几何体，
 * 会走这条回退路径。
 *
 * @param {{xs:Float64Array, ys:Float64Array, azs:Float64Array, n:number}} tris
 * @param {{xMin:number, xMax:number}} range
 * @param {number} deckHeight 底切高度
 * @param {number} N 采样段数
 * @param {number} bandH 窗口高度（默认 0.06）
 * @param {number} fallback 无三角形时的回退值
 * @returns {number[]} 长度 N
 */
export function cutEdgeProfile(tris, range, deckHeight, N = 24, bandH = 0.06, fallback = NaN) {
  const { xs, ys, azs, n } = tris;
  const L = range.xMax - range.xMin;
  const halfWin = L / (2 * N);
  const yHi = deckHeight + bandH;

  // 一次性分桶，避免 O(N × n)
  const maxOf = new Float64Array(N).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (y < deckHeight || y > yHi) continue;
    const t = (xs[i] - range.xMin) / L;
    if (t < 0 || t >= 1) continue;
    const b = Math.min(N - 1, Math.floor(t * N));
    if (azs[i] > maxOf[b]) maxOf[b] = azs[i];
  }

  const fb = Number.isFinite(fallback) ? fallback : 0;
  const out = new Array(N);
  for (let b = 0; b < N; b++) {
    out[b] = Number.isFinite(maxOf[b]) ? maxOf[b] : fb;
    void halfWin; // 采样窗口即整段，无需额外判据
  }
  return out;
}

/**
 * 轮拱处车身半宽剖面（沿车长采样）。
 *
 * 在每个采样窗口内，取 y ∈ [yLo, yHi] 的三角形中 |z| 的最大值。
 * 这个值比全局 bodyHalfWidth 更能代表「当前 X 位置处翼子板/轮拱能给轮胎留出的横向空间」。
 *
 * @param {{xs:Float64Array, ys:Float64Array, azs:Float64Array, n:number}} tris
 * @param {{xMin:number, xMax:number}} range
 * @param {number} yLo 轮拱高度下界（米，默认 0.22）
 * @param {number} yHi 轮拱高度上界（米，默认 0.78）
 * @param {number} N 采样段数（默认 32）
 * @param {number} fallback 无三角形时的回退值
 * @returns {number[]} 长度 N
 */
export function fenderProfile(tris, range, yLo = 0.22, yHi = 0.78, N = 32, fallback = NaN) {
  const { xs, ys, azs, n } = tris;
  const L = range.xMax - range.xMin;
  const maxOf = new Float64Array(N).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (y < yLo || y > yHi) continue;
    const t = (xs[i] - range.xMin) / L;
    if (t < 0 || t >= 1) continue;
    const b = Math.min(N - 1, Math.floor(t * N));
    if (azs[i] > maxOf[b]) maxOf[b] = azs[i];
  }
  const fb = Number.isFinite(fallback) ? fallback : 0;
  const out = new Array(N);
  for (let b = 0; b < N; b++) {
    out[b] = Number.isFinite(maxOf[b]) ? maxOf[b] : fb;
  }
  return out;
}

/**
 * 轮拱下沿高度剖面（沿车长采样）。
 *
 * 对每个采样窗口，先在 [yLo, yHi] 内取该段半宽 fenderHw，再在
 * |z| ∈ [zInner * fenderHw, zOuter * fenderHw] 的三角形中取最小 y，
 * 即该 X 位置轮拱开口的下沿高度。轮胎顶部必须低于此高度。
 *
 * @param {{xs:Float64Array, ys:Float64Array, azs:Float64Array, n:number}} tris
 * @param {{xMin:number, xMax:number}} range
 * @param {number[]} fenderHw 各段轮拱半宽（米）
 * @param {{yLo?:number, yHi?:number, zInner?:number, zOuter?:number, fallback?:number}} [opts]
 * @returns {number[]} 长度与 fenderHw 相同
 */
export function archHeightProfile(tris, range, fenderHw, opts = {}) {
  const yLo = opts.yLo ?? 0.18;
  const yHi = opts.yHi ?? 1.0;
  const zInner = opts.zInner ?? 0.45;
  const zOuter = opts.zOuter ?? 0.95;
  const fallback = opts.fallback ?? 0.75;

  const { xs, ys, azs, n } = tris;
  const L = range.xMax - range.xMin;
  const N = fenderHw.length;
  const minOf = new Float64Array(N).fill(Infinity);

  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (y < yLo || y > yHi) continue;
    const t = (xs[i] - range.xMin) / L;
    if (t < 0 || t >= 1) continue;
    const b = Math.min(N - 1, Math.floor(t * N));
    const hw = fenderHw[b];
    if (!Number.isFinite(hw) || hw <= 0) continue;
    const zMin = zInner * hw;
    const zMax = zOuter * hw;
    if (azs[i] < zMin || azs[i] > zMax) continue;
    if (ys[i] < minOf[b]) minOf[b] = ys[i];
  }

  const out = new Array(N);
  for (let b = 0; b < N; b++) {
    out[b] = Number.isFinite(minOf[b]) ? minOf[b] : fallback;
  }
  return out;
}

/** 车壳测量结果的形状（T02/T03 的接口契约） */
/**
 * @typedef {Object} ShellMetrics
 * @property {number} bodyHalfWidth 车身半宽（米），来自分位数
 * @property {number[]} cutEdgeProfile 底切处切口半宽剖面
 * @property {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} bbox
 * @property {number} triCount 三角形数
 * @property {number} heightNorm 归一化车高
 * @property {number} lengthNorm 归一化车长
 * @property {number} xMin
 * @property {number} xMax
 */

/**
 * 对一棵已归一（车长 = carLength、车底贴地 y=0）的车壳做完整测量。
 *
 * @param {THREE.Object3D} root
 * @param {{bandPct?:number, profileN?:number, deckHeight?:number}} [opts]
 * @returns {ShellMetrics}
 */
export function measure(root, opts = {}) {
  const bandPct = opts.bandPct ?? 0.995;
  const profileN = opts.profileN ?? 24;
  const deckHeight = opts.deckHeight ?? 0.3;

  const tris = collectTriangles(root);
  const box = tris.box;
  const heightNorm = Math.max(1e-6, box.max.y - box.min.y);
  const lengthNorm = Math.max(1e-6, box.max.x - box.min.x);

  // Step 1 — 车身半宽
  // 测量带按**车长**归一（不是车高），这是复现设计基线 0.9299 的口径，见上面 bodyHalfWidth 的注释
  let bhw = bodyHalfWidth(
    tris,
    box.min.y + BAND_LO * lengthNorm,
    box.min.y + BAND_HI * lengthNorm,
    bandPct
  );
  if (!Number.isFinite(bhw) || bhw <= 0) {
    // 高度带里一个三角形都没有（极端模型）→ 退到整体 |z| 分位数
    bhw = percentile(tris.azs.subarray(0, tris.n), bandPct);
  }
  if (!Number.isFinite(bhw) || bhw <= 0) bhw = (box.max.z - box.min.z) / 2;
  // clamp：防止离群值把底盘推到离谱的位置
  bhw = Math.min(0.5 * lengthNorm, Math.max(0.2, bhw));

  // Step 2 — 切口轮廓（回退到 bodyHalfWidth × 0.82）
  const profile = cutEdgeProfile(
    tris,
    { xMin: box.min.x, xMax: box.max.x },
    deckHeight,
    profileN,
    0.06,
    bhw * 0.82
  );

  // Step 3 — 轮拱空间剖面：给 wheelRig 做精确防穿模用。
  // N=32 足够覆盖前后轴附近的轮拱曲线，更新时线性插值。
  const FENDER_N = 32;
  const fProf = fenderProfile(
    tris,
    { xMin: box.min.x, xMax: box.max.x },
    0.22,
    0.58,
    FENDER_N,
    bhw
  );
  const aProf = archHeightProfile(
    tris,
    { xMin: box.min.x, xMax: box.max.x },
    fProf,
    { fallback: heightNorm * 0.55 }
  );

  return {
    bodyHalfWidth: bhw,
    cutEdgeProfile: profile,
    fenderProfile: fProf,
    archHeightProfile: aProf,
    bbox: {
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
    },
    triCount: tris.n,
    heightNorm,
    lengthNorm,
    xMin: box.min.x,
    xMax: box.max.x,
  };
}
