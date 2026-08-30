/**
 * probe-wheels.mjs — 从归一化后的车模网格直接探测四个车轮位置
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { normalizeCar } from '../src/core/glb.js';

const GLB = process.argv[2] || 'public/models/my-car.glb';
const TARGET_LEN = Number(process.argv[3] || 4.6);

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
    const o = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const n = { VEC3: 3, VEC2: 2, SCALAR: 1 }[a.type];
    const base = bin.byteOffset + o;
    if (a.componentType === 5126) return new Float32Array(bin.buffer, base, a.count * n);
    if (a.componentType === 5125) return new Uint32Array(bin.buffer, base, a.count * n);
    return new Uint16Array(bin.buffer, base, a.count * n);
  };
  let positions = [];
  let indices = [];
  for (const m of json.meshes || [])
    for (const p of m.primitives || []) {
      const pa = acc(p.attributes.POSITION);
      const base = positions.length / 3;
      for (let i = 0; i < pa.length; i++) positions.push(pa[i]);
      const ia = p.indices !== undefined ? acc(p.indices) : null;
      if (ia) for (let i = 0; i < ia.length; i++) indices.push(ia[i] + base);
      else for (let i = 0; i < pa.length / 3; i++) indices.push(i + base);
    }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const { positions, indices } = readGLB(GLB);
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geo.setIndex(new THREE.BufferAttribute(indices, 1));

const carOuter = new THREE.Group();
const carInner = new THREE.Group();
carInner.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
carOuter.add(carInner);

normalizeCar(carInner, { targetLength: TARGET_LEN, groundY: 0 });
carOuter.updateMatrixWorld(true);
const b0 = new THREE.Box3().setFromObject(carOuter);
carOuter.position.x -= (b0.min.x + b0.max.x) / 2;
carOuter.position.z -= (b0.min.z + b0.max.z) / 2;
carOuter.position.y -= b0.min.y;
carOuter.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(carOuter);
const size = box.getSize(new THREE.Vector3());
console.log(`车 ${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)} (L×H×W)`);

const m = carOuter.children[0].children[0].matrixWorld;
const V = new THREE.Vector3();
const tri = indices.length / 3;
const T = [];
for (let t = 0; t < tri; t++) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 3; k++) {
    V.fromBufferAttribute(geo.attributes.position, indices[t * 3 + k]).applyMatrix4(m);
    x += V.x; y += V.y; z += V.z;
  }
  T.push({ x: x / 3, y: y / 3, z: z / 3 });
}

const H = size.y;

// 对四个象限的下半部三角形，按 (x,z) 做 2D 核密度峰值
function findCorner(label, xSign, zSign) {
  const xs = [], ys = [], zs = [];
  for (const t of T) {
    if (t.y > 0.55 * H) continue; // 只保留下半部
    if (xSign > 0 ? t.x < 0.08 * size.x : t.x > -0.08 * size.x) continue;
    if (zSign > 0 ? t.z < 0 : t.z > 0) continue;
    xs.push(t.x); ys.push(t.y); zs.push(Math.abs(t.z));
  }
  console.log(`\n${label}: 候选面 ${xs.length}`);
  if (!xs.length) return null;

  // 简单均值 + 过滤远离均值的离群点（去除平板/车身主体）
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;

  // 迭代 refine：只保留离 (meanX, meanZ) 较近的三角形
  let cx = meanX, cz = meanZ, cy = meanY;
  for (let it = 0; it < 3; it++) {
    const closeX = [], closeY = [], closeZ = [];
    let rad = 0.45; // m
    let n = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - cx, dz = zs[i] - cz;
      if (Math.hypot(dx, dz) < rad) {
        closeX.push(xs[i]); closeY.push(ys[i]); closeZ.push(zs[i]); n++;
      }
    }
    if (!n) break;
    cx = closeX.reduce((a, b) => a + b, 0) / n;
    cy = closeY.reduce((a, b) => a + b, 0) / n;
    cz = closeZ.reduce((a, b) => a + b, 0) / n;
  }

  // 统计半径：这些三角形的 y 分布（底部=0，顶部≈轮径）
  const inR = [];
  for (let i = 0; i < xs.length; i++) {
    if (Math.hypot(xs[i] - cx, zs[i] - cz) < 0.5) inR.push(ys[i]);
  }
  inR.sort((a, b) => a - b);
  const topY = inR.length ? inR[Math.floor(inR.length * 0.92)] : cy;
  const rEst = topY; // 轮心高 ≈ 半径（底部 y=0）
  console.log(`  中心 x=${cx.toFixed(3)} y=${cy.toFixed(3)} z=${(zSign > 0 ? cz : -cz).toFixed(3)}  估算轮径=${rEst.toFixed(3)}m`);
  return { x: cx, y: cy, z: zSign > 0 ? cz : -cz, r: rEst };
}

const FL = findCorner('FL 前左', 1, 1);
const FR = findCorner('FR 前右', 1, -1);
const RL = findCorner('RL 后左', -1, 1);
const RR = findCorner('RR 后右', -1, -1);

console.log('\n=== 建议 autoFitCorners 参数（基于当前 GLB）===');
if (FL && FR && RL && RR) {
  const frontX = (FL.x + FR.x) / 2;
  const rearX = (RL.x + RR.x) / 2;
  const halfTrack = (Math.abs(FL.z) + Math.abs(FR.z) + Math.abs(RL.z) + Math.abs(RR.z)) / 4;
  const wheelR = (FL.r + FR.r + RL.r + RR.r) / 4;
  console.log(`  前轴 x = ${frontX.toFixed(3)}  (占车长 ${((frontX / size.x + 0.5) * 100).toFixed(1)}% 从前)`);
  console.log(`  后轴 x = ${rearX.toFixed(3)}  (占车长 ${((-rearX / size.x + 0.5) * 100).toFixed(1)}% 从后)`);
  console.log(`  半轮距 = ${halfTrack.toFixed(3)}`);
  console.log(`  轮半径 ≈ ${wheelR.toFixed(3)}`);
}
