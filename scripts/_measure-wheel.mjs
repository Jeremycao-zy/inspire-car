/**
 * 精确测量车模原车轮的真实垂直范围。
 *
 * 思路：detectWheelCenters 的 y 是「车轮+轮拱+车身侧板」混合簇的质心，被车身拉高，不可信。
 * 改用轮廓法：在车轮 x 位置取一片薄板，逐 y 求 max|z|。
 * 轮胎胎侧是整车最宽处，所以 max|z| 接近峰值的那一段 y 区间，就是轮胎真实的上下边界。
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { normalizeCar } from '../src/core/glb.js';

const GLB = 'public/models/my-car.glb';
const TARGET_LEN = 4.6;

function readGLB(file) {
  const data = fs.readFileSync(file);
  let off = 12;
  const chunks = [];
  while (off < data.length) {
    const len = data.readUInt32LE(off);
    const type = data.readUInt32LE(off + 4);
    chunks.push([type, data.subarray(off + 8, off + 8 + len)]);
    off += 8 + len;
  }
  const json = JSON.parse(chunks.find((c) => c[0] === 0x4e4f534a)[1].toString('utf8'));
  const bin = chunks.find((c) => c[0] !== 0x4e4f534a)[1];
  const acc = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const base = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const n = { VEC3: 3, VEC2: 2, SCALAR: 1 }[a.type];
    if (a.componentType === 5126) return new Float32Array(bin.buffer, base, a.count * n);
    if (a.componentType === 5125) return new Uint32Array(bin.buffer, base, a.count * n);
    return new Uint16Array(bin.buffer, base, a.count * n);
  };
  const P = [];
  const I = [];
  for (const m of json.meshes || [])
    for (const p of m.primitives || []) {
      const pa = acc(p.attributes.POSITION);
      const base = P.length / 3;
      for (let i = 0; i < pa.length; i++) P.push(pa[i]);
      if (p.indices !== undefined) {
        const ia = acc(p.indices);
        for (let i = 0; i < ia.length; i++) I.push(ia[i] + base);
      } else {
        for (let i = 0; i < pa.length / 3; i++) I.push(i + base);
      }
    }
  return { pos: new Float32Array(P), idx: new Uint32Array(I) };
}

const { pos: raw, idx: rawIdx } = readGLB(GLB);
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(raw.slice(), 3));
geo.setIndex(new THREE.BufferAttribute(rawIdx.slice(), 1));
const g = new THREE.Group();
g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
normalizeCar(g, { targetLength: TARGET_LEN, groundY: 0 });
g.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(g);
const size = box.getSize(new THREE.Vector3());
console.log(
  `车 L=${size.x.toFixed(3)} H=${size.y.toFixed(3)} W=${size.z.toFixed(3)}  ` +
    `y∈[${box.min.y.toFixed(3)},${box.max.y.toFixed(3)}]`
);

const n = raw.length / 3;
const V = new THREE.Vector3();
const MW = g.children[0].matrixWorld;
const P = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  V.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(MW);
  P[i * 3] = V.x; P[i * 3 + 1] = V.y; P[i * 3 + 2] = V.z;
}

const { detectWheelCenters } = await import('../src/tuning/wheelFit.js');
const det = detectWheelCenters(g, size);
console.log('\ndetectWheelCenters 给出的值（y 是混合簇质心，被车身拉高，仅 x/z 可信）：');
for (const [id, v] of Object.entries(det.raw)) {
  console.log(
    `  ${id}  x=${v.x.toFixed(3)}  y=${v.y.toFixed(3)}  |z|=${Math.abs(v.z).toFixed(3)}  r=${v.r.toFixed(3)}`
  );
}

/* ---- 轮廓法：车轮 x 薄板内，逐 y 求 max|z| ---- */
console.log('\n=== 轮廓法：车轮薄板内 max|z| 随 y 的变化 ===');
console.log('（轮胎胎侧是最宽处；max|z| 接近峰值的 y 区间 = 轮胎真实上下边界）\n');

const SLAB = 0.10; // 薄板半宽（m）
const BIN = 0.02; // y 分箱（m）

for (const id of ['FL', 'RL']) {
  const w = det.raw[id];
  const wx = w.x;
  const zSign = Math.sign(w.z);

  const nb = Math.ceil(size.y / BIN);
  const maxZ = new Float64Array(nb).fill(0);
  const maxZall = new Float64Array(nb).fill(0); // 全车宽对照

  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = Math.abs(P[i * 3 + 2]);
    const b = Math.floor((y - box.min.y) / BIN);
    if (b < 0 || b >= nb) continue;
    if (z > maxZall[b]) maxZall[b] = z;
    if (Math.abs(x - wx) <= SLAB && z > maxZ[b]) maxZ[b] = z;
  }

  let peak = 0;
  for (let b = 0; b < nb; b++) peak = Math.max(peak, maxZ[b]);

  console.log(`── ${id}（x≈${wx.toFixed(3)}，薄板 ±${SLAB}m）峰值 max|z| = ${peak.toFixed(3)} ──`);
  console.log('   y(m)   max|z|   条状图（* = 达到峰值 90% 以上，判定为轮胎胎侧）');
  let yLo = null, yHi = null;
  for (let b = 0; b < nb; b++) {
    const y = box.min.y + (b + 0.5) * BIN;
    if (y > 1.0) break;
    const v = maxZ[b];
    const isTire = v >= peak * 0.9;
    if (isTire) {
      if (yLo === null) yLo = y;
      yHi = y;
    }
    const bar = '█'.repeat(Math.round((v / (size.z / 2)) * 40));
    console.log(
      `  ${y.toFixed(3)}  ${v.toFixed(3)}  ${bar}${isTire ? '  *' : ''}`
    );
  }
  console.log(
    `  → 轮胎真实垂直范围: y ∈ [${yLo?.toFixed(3) ?? '?'}, ${yHi?.toFixed(3) ?? '?'}]  ` +
      `直径 ≈ ${(((yHi ?? 0) - (yLo ?? 0)) * 1000).toFixed(0)}mm  ` +
      `中心高 ≈ ${((((yHi ?? 0) + (yLo ?? 0)) / 2) * 1000).toFixed(0)}mm`
  );
  console.log('');
}

/* ---- 对照：全车最大半宽 ---- */
console.log('=== 对照：全车逐 y 的 max|z|（看车身最宽处在哪） ===');
{
  const nb = Math.ceil(size.y / BIN);
  const mz = new Float64Array(nb).fill(0);
  for (let i = 0; i < n; i++) {
    const y = P[i * 3 + 1], z = Math.abs(P[i * 3 + 2]);
    const b = Math.floor((y - box.min.y) / BIN);
    if (b < 0 || b >= nb) continue;
    if (z > mz[b]) mz[b] = z;
  }
  for (let b = 0; b < nb; b++) {
    const y = box.min.y + (b + 0.5) * BIN;
    if (y > 1.0) break;
    console.log(`  y=${y.toFixed(3)}  max|z|=${mz[b].toFixed(3)}  ${'█'.repeat(Math.round((mz[b] / (size.z / 2)) * 40))}`);
  }
}
