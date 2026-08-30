/** 临时：复现设计文档 §1.2 的「按 y 分层面数与宽度剖面」表，核对统计口径 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { readGLBWorld } from './_glb.mjs';
import { normalizeCar, boxOf } from '../src/core/glb.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const { pos, idx } = readGLBWorld(path.join(ROOT, 'public/models/my-car.glb'));
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setIndex(new THREE.BufferAttribute(idx, 1));
const carOuter = new THREE.Group();
const carInner = new THREE.Group();
carInner.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
carOuter.add(carInner);
normalizeCar(carInner, { targetLength: 4.6, groundY: 0 });
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
const H = size.y;
const MW = carInner.children[0].matrixWorld;
const v = new THREE.Vector3();
const n = pos.length / 3;
const wy = new Float64Array(n);
const wz = new Float64Array(n);
for (let i = 0; i < n; i++) {
  v.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(MW);
  wy[i] = v.y;
  wz[i] = v.z;
}

console.log('包围盒 L=' + size.x.toFixed(3) + ' H=' + H.toFixed(4) + ' W=' + size.z.toFixed(3) + '  minY=' + box.min.y.toFixed(4));

function pct(arr, p) {
  const a = arr;
  a.sort((x, y) => x - y);
  if (!a.length) return NaN;
  const q = (a.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(q);
  const hi = Math.ceil(q);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (q - lo);
}

/* ---- 按 y 分层：面数 + max|z|（重心 / 顶点两种口径） ---- */
const LAYERS = [
  [0.0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.35], [0.35, 0.4], [0.4, 0.5],
  [0.5, 0.6], [0.6, 0.7], [0.7, 0.9], [0.9, 1.4],
];
console.log('\n按 y 分层：');
console.log('  y 区间(m)      面数   max|z|重心  max|z|顶点');
for (const [lo, hi] of LAYERS) {
  let cnt = 0;
  let mc = 0;
  let mv = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const cy = (wy[a] + wy[b] + wy[c]) / 3;
    if (cy < lo || cy >= hi) continue;
    cnt++;
    const zc = Math.abs((wz[a] + wz[b] + wz[c]) / 3);
    const zv = Math.max(Math.abs(wz[a]), Math.abs(wz[b]), Math.abs(wz[c]));
    if (zc > mc) mc = zc;
    if (zv > mv) mv = zv;
  }
  console.log(
    '  ' + (lo.toFixed(2) + '–' + hi.toFixed(2)).padEnd(12) + String(cnt).padStart(7) +
    '   ' + mc.toFixed(4).padStart(9) + '  ' + mv.toFixed(4).padStart(10)
  );
}

/* ---- 测量带口径对比 ---- */
function show(name, arr) {
  const p = (x) => pct(arr, x).toFixed(4);
  let mx = -Infinity;
  for (const x of arr) if (x > mx) mx = x;
  console.log(
    name.padEnd(22) + ' n=' + String(arr.length).padStart(7) +
    '  p50=' + p(0.5) + ' p90=' + p(0.9) + ' p98=' + p(0.98) +
    ' p99.5=' + p(0.995) + ' p99.9=' + p(0.999) + ' max=' + mx.toFixed(4)
  );
}

const variants = [
  { name: 'A: [0.60H, 0.85H] 米', lo: box.min.y + 0.6 * H, hi: box.min.y + 0.85 * H },
  { name: 'B: [0.60, 0.85] 米', lo: box.min.y + 0.6, hi: box.min.y + 0.85 },
  { name: 'C: [0.1304L, 0.1848L]', lo: box.min.y + 0.1304 * size.x, hi: box.min.y + 0.1848 * size.x },
  { name: 'D: [0.50H, 0.66H] 米', lo: box.min.y + 0.5 * H, hi: box.min.y + 0.66 * H },
];
console.log('');
for (const vd of variants) {
  console.log('测量带 ' + vd.name + '  →  y∈[' + vd.lo.toFixed(4) + ', ' + vd.hi.toFixed(4) + ']');
  const cen = [];
  const vtxMax = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const cy = (wy[a] + wy[b] + wy[c]) / 3;
    if (cy < vd.lo || cy > vd.hi) continue;
    cen.push(Math.abs((wz[a] + wz[b] + wz[c]) / 3));
    vtxMax.push(Math.max(Math.abs(wz[a]), Math.abs(wz[b]), Math.abs(wz[c])));
  }
  show('  重心 |z|', cen);
  show('  顶点 max|z|', vtxMax);
}
console.log('\n基线(设计 §1.4)  p50=0.7538 p90=0.9056 p98=0.9201 p99.5=0.9299 p99.9=0.9339 max=0.9355');
