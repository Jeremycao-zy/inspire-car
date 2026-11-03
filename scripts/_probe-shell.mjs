/**
 * _probe-shell.mjs — 车壳测量 + 三道切割的独立验证（临时脚本，前缀 _，非产物）
 *
 * 输出设计文档 §4.3 / 附表的全部数字，供与架构师基线逐项比对：
 *   · bodyHalfWidth（目标 ∈ [0.925, 0.935]）
 *   · cutEdgeProfile（长度 24，无 NaN）
 *   · C1 / C2 / C3 各道与并集的移除面数（基线 10,578 / 1,082 / 7,357 / 18,197）
 *   · 贴图轮子区域残留（前轴圆盘内 |z|>0.85：切前 545 → 目标 0）
 *   · 保留部分 minY / max|z|
 *   · restore() 还原一致性、_key 缓存命中
 *
 * 用法：node scripts/_probe-shell.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { readGLBWorld } from './_glb.mjs';
import { normalizeCar, boxOf } from '../src/core/glb.js';
import { measure, collectTriangles } from '../src/tuning/shellMeasure.js';
import { ShellCutter, SHELL_DEFAULTS } from '../src/tuning/shellCutter.js';
import { ChassisParams, OE_SPEC } from '../src/tuning/chassis.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GLB = path.join(ROOT, 'public/models/my-car.glb');
const CAR_LENGTH = 4.6;

/* ---------------- GLB ---------------- */
console.log('\n══════════ 车壳测量 + 三道切割验证 ══════════\n');

const { pos, idx } = readGLBWorld(GLB);
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setIndex(new THREE.BufferAttribute(idx, 1));

const scene = new THREE.Scene();
const carOuter = new THREE.Group();
carOuter.name = 'carOuter';
const carInner = new THREE.Group();
carInner.name = 'carInner';
carInner.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
carOuter.add(carInner);
scene.add(carOuter);

carInner.position.set(0, 0, 0);
carInner.quaternion.identity();
carInner.scale.set(1, 1, 1);
normalizeCar(carInner, { targetLength: CAR_LENGTH, groundY: 0 });
carOuter.updateMatrixWorld(true);
{
  const b = boxOf(carOuter);
  carOuter.position.x -= (b.min.x + b.max.x) / 2;
  carOuter.position.z -= (b.min.z + b.max.z) / 2;
  carOuter.position.y -= b.min.y;
  carOuter.updateMatrixWorld(true);
}

const box = boxOf(carOuter);
const size = box.getSize(new THREE.Vector3());
console.log(`归一后包围盒 L=${size.x.toFixed(3)} H=${size.y.toFixed(3)} W=${size.z.toFixed(3)}`);
console.log(`三角面数 ${(idx.length / 3).toLocaleString()}`);

/* ---------------- 1. 测量 ---------------- */
const FRONT = { rimInch: 19, j: 8.5, et: 30, tireWidthMm: 255, aspect: 35, camber: -1.0 };
const REAR = { rimInch: 19, j: 9.5, et: 31, tireWidthMm: 285, aspect: 30, camber: -1.5 };

const metrics = measure(carOuter, { deckHeight: 0.3 });
console.log(`\n── ShellMeasure ──`);
console.log(`  bodyHalfWidth = ${metrics.bodyHalfWidth.toFixed(4)}  （基线 0.9299，目标区间 [0.925, 0.935]）`);
console.log(`  heightNorm    = ${metrics.heightNorm.toFixed(4)}   lengthNorm = ${metrics.lengthNorm.toFixed(4)}`);
console.log(`  triCount      = ${metrics.triCount.toLocaleString()}`);
const badProfile = metrics.cutEdgeProfile.filter((v) => !Number.isFinite(v)).length;
console.log(`  cutEdgeProfile N=${metrics.cutEdgeProfile.length}  非法值 ${badProfile}`);
console.log(`    ${metrics.cutEdgeProfile.map((v) => v.toFixed(2)).join(' ')}`);

/* ---------------- 2. 底盘参数 ---------------- */
const params = new ChassisParams({ carLength: CAR_LENGTH }).derive(metrics, { front: FRONT, rear: REAR });
console.log(`\n── ChassisParams.derive() ──`);
const cmp = (name, v, base) =>
  console.log(`  ${name.padEnd(13)} = ${v.toFixed(4).padStart(8)}   基线 ${base.toFixed(4).padStart(8)}   差 ${((v - base) * 1000).toFixed(1).padStart(7)} mm`);
cmp('wheelbase', params.wheelbase, 2.597);
cmp('axleX_F', params.axleX_F, 1.367);
cmp('axleX_R', params.axleX_R, -1.23);
cmp('halfTrack_F', params.halfTrack_F, 0.7988);
cmp('halfTrack_R', params.halfTrack_R, 0.7923);
cmp('hubY_F', params.hubY_F, 0.3353);
cmp('hubY_R', params.hubY_R, 0.3315);
cmp('archR_F', params.archR_F, 0.38);
cmp('archR_R', params.archR_R, 0.376);
cmp('archInnerZ_F', params.archInnerZ_F, 0.6495);
cmp('archInnerZ_R', params.archInnerZ_R, 0.6278);
cmp('clipZ', params.clipZ, 0.9449);
cmp('clipTopY', params.clipTopY, 0.55);
cmp('deckHeight', params.deckHeight, 0.3);
cmp('rideHeight', params.rideHeight, 0.125);
console.log(`  shellLift     = ${(params.shellLift * 1000).toFixed(2)} mm`);

const plan = params.cutPlan();

/* ---------------- 3. 三道切割（逐道 + 并集） ---------------- */
const tris = collectTriangles(carOuter);
const N = tris.n;

const pred = {
  C1: (x, y) => y < plan.deckHeight,
  C2: (x, y, az) => az > plan.clipZ && y < plan.clipTopY,
  C3: (x, y, az) => {
    for (const a of plan.arches) {
      if (az <= a.innerZ) continue;
      const dx = x - a.axleX;
      const dy = y - a.hubY;
      if (dx * dx + dy * dy < a.radius * a.radius) return true;
    }
    return false;
  },
};

const count = (fn) => {
  let n = 0;
  for (let i = 0; i < N; i++) if (fn(tris.xs[i], tris.ys[i], tris.azs[i])) n++;
  return n;
};

const c1 = count((x, y) => pred.C1(x, y));
const c2 = count((x, y, az) => pred.C2(x, y, az));
const c3 = count((x, y, az) => pred.C3(x, y, az));
const c3f = count((x, y, az) => {
  const a = plan.arches[0];
  return az > a.innerZ && Math.hypot(x - a.axleX, y - a.hubY) < a.radius;
});
const c3r = count((x, y, az) => {
  const a = plan.arches[2];
  return az > a.innerZ && Math.hypot(x - a.axleX, y - a.hubY) < a.radius;
});
const union = count((x, y, az) => pred.C1(x, y) || pred.C2(x, y, az) || pred.C3(x, y, az));

console.log(`\n── 三道切割（架构师基线对照）──`);
const row = (name, v, base) =>
  console.log(
    `  ${name.padEnd(16)} ${String(v).padStart(7)}  ${((v / N) * 100).toFixed(2).padStart(6)}%   基线 ${String(base).padStart(7)}   差 ${String(v - base).padStart(6)}`
  );
row('C1 底切', c1, 10578);
row('C2 侧切', c2, 1082);
row('C3 前拱', c3f, 2580);
row('C3 后拱', c3r, 4777);
row('C3 合计', c3, 7357);
row('并集移除', union, 18197);
console.log(`  保留                 ${N - union}  ${(((N - union) / N) * 100).toFixed(2)}%`);

/* ---------------- 4. 贴图轮子区域残留 ---------------- */
const F = plan.arches[0];
const inWheelDecal = (x, y, az) =>
  az > 0.85 && Math.hypot(x - F.axleX, y - F.hubY) < F.hubY * 1.02;

const inUnion = (i) => {
  const x = tris.xs[i], y = tris.ys[i], az = tris.azs[i];
  return pred.C1(x, y) || pred.C2(x, y, az) || pred.C3(x, y, az);
};

let decalBefore = 0;
let decalAfter = 0;
for (let i = 0; i < N; i++) {
  if (!inWheelDecal(tris.xs[i], tris.ys[i], tris.azs[i])) continue;
  decalBefore++;
  if (!inUnion(i)) decalAfter++;
}
console.log(`\n── 贴图轮子区域残留（前轴圆盘 hypot<hubY*1.02 且 |z|>0.85）──`);
console.log(`  切割前 ${decalBefore} 面（基线 545）`);
console.log(`  切割后 ${decalAfter} 面（目标 0）  ${decalAfter === 0 ? '✅' : '❌'}`);

/* ---------------- 5. ShellCutter 实跑 ---------------- */
const cutter = new ShellCutter();
const nMeshes = cutter.capture(carOuter);
const before = idx.slice();
cutter.apply(plan, SHELL_DEFAULTS);
const st = cutter.stats();

console.log(`\n── ShellCutter.apply() ──`);
console.log(`  接管网格 ${nMeshes}  totalTris=${st.totalTris.toLocaleString()}  removedTris=${st.removedTris.toLocaleString()}  kept=${st.keptTris.toLocaleString()}`);
console.log(`  与逐道统计的并集一致性：${st.removedTris === union ? '✅ 一致' : `❌ 不一致（差 ${st.removedTris - union}）`}`);

// 保留部分的 minY / max|z|
{
  const work = cutter.entries[0].work.array;
  const wp = cutter.entries[0].world;
  let minY = Infinity;
  let maxAz = 0;
  for (let t = 0; t < work.length; t += 3) {
    const a = work[t], b = work[t + 1], c = work[t + 2];
    if (a === b && b === c) break;
    const y = (wp[a * 3 + 1] + wp[b * 3 + 1] + wp[c * 3 + 1]) / 3;
    const az = Math.abs((wp[a * 3 + 2] + wp[b * 3 + 2] + wp[c * 3 + 2]) / 3);
    if (y < minY) minY = y;
    if (az > maxAz) maxAz = az;
  }
  console.log(`  保留部分 minY = ${minY.toFixed(4)}（应 ≥ deckHeight ${plan.deckHeight.toFixed(3)}）${minY >= plan.deckHeight - 1e-6 ? ' ✅' : ' ❌'}`);
  console.log(`  保留部分 max|z| = ${maxAz.toFixed(4)}（应 ≤ clipZ ${plan.clipZ.toFixed(4)}）${maxAz <= plan.clipZ + 1e-6 ? ' ✅' : ' ❌'}`);
}

// 材质 side
{
  const m = cutter.entries[0].mesh.material;
  const THREE_DBL = 2;
  console.log(`  车壳材质 side = ${m.side}（DoubleSide=${THREE_DBL}）${m.side === THREE_DBL ? ' ✅' : ' ❌'}`);
}

// _key 缓存
{
  const b0 = cutter.buildCount;
  cutter.apply(plan, SHELL_DEFAULTS);
  const b1 = cutter.buildCount;
  console.log(`  重复 apply 同一 plan：buildCount ${b0} → ${b1} ${b1 === b0 ? '✅ 命中缓存' : '❌ 未命中'}`);
}

// restore 一致性
{
  cutter.restore();
  const after = cutter.entries[0].geo.index.array;
  let same = after.length === before.length;
  if (same) for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { same = false; break; }
  const m = cutter.entries[0].mesh.material;
  console.log(`  restore() 后 removedTris=${cutter.stats().removedTris}，索引与原始一致：${same ? '✅' : '❌'}，材质 side 还原：${m.side === 0 ? '✅' : `❌ (${m.side})`}`);
}

/* ---------------- 6. 极端输入 clamp ---------------- */
console.log(`\n── 极端 bodyHalfWidth 的 clamp ──`);
for (const bhw of [0.6, 0.9299, 1.2]) {
  const q = new ChassisParams({ carLength: CAR_LENGTH }).derive(
    { bodyHalfWidth: bhw, lengthNorm: CAR_LENGTH, cutEdgeProfile: metrics.cutEdgeProfile },
    { front: FRONT, rear: REAR }
  );
  const allFinite = [q.wheelbase, q.axleX_F, q.axleX_R, q.halfTrack_F, q.halfTrack_R, q.hubY_F, q.hubY_R, q.archR_F, q.archInnerZ_F].every(Number.isFinite);
  console.log(
    `  bhw=${bhw.toFixed(4)}  halfTrack_F=${q.halfTrack_F.toFixed(4)}  halfTrack_R=${q.halfTrack_R.toFixed(4)}  ` +
    `axleX_F=${q.axleX_F.toFixed(4)}  axleX_R=${q.axleX_R.toFixed(4)}  全部有限=${allFinite ? '✅' : '❌'}`
  );
}

console.log('\n══════════ 验证结束 ══════════\n');
