/**
 * ascii.mjs — 把 GLB 打成 ASCII 轮廓图，直接在终端看车形
 *
 * 用法：node scripts/ascii.mjs [glb] [目标车长]
 *
 * 输出三张图：
 *   侧视（x 横 / y 纵）      俯视（x 横 / z 纵）      后视（z 横 / y 纵）
 * 字符深浅 = 该格子里有多少个投影点（对数映射）
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { normalizeCar } from '../src/core/glb.js';

const GLB = process.argv[2] || 'public/models/my-car.glb';
const TARGET_LEN = Number(process.argv[3] || 4.6);

/* ---------- 读 GLB（只要顶点） ---------- */
function readPositions(file) {
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
    return new Float32Array(bin.buffer, base, a.count * { VEC3: 3, VEC2: 2, SCALAR: 1 }[a.type]);
  };
  const out = [];
  for (const m of json.meshes || [])
    for (const p of m.primitives || []) {
      const pa = acc(p.attributes.POSITION);
      for (let i = 0; i < pa.length; i += 3) out.push(pa[i], pa[i + 1], pa[i + 2]);
    }
  return new Float32Array(out);
}

const raw = readPositions(GLB);
console.log(`顶点数 ${raw.length / 3}`);

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(raw.slice(), 3));
const g = new THREE.Group();
g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
normalizeCar(g, { targetLength: TARGET_LEN, groundY: 0 });
g.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(g);
const size = box.getSize(new THREE.Vector3());
console.log(
  `摆正后  L=${size.x.toFixed(3)}  H=${size.y.toFixed(3)}  W=${size.z.toFixed(3)}   ` +
    `x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(2)},${box.max.y.toFixed(2)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}]`
);

const n = raw.length / 3;
const P = new Float32Array(n * 3);
const V = new THREE.Vector3();
const MW = g.children[0].matrixWorld;
for (let i = 0; i < n; i++) {
  V.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(MW);
  P[i * 3] = V.x; P[i * 3 + 1] = V.y; P[i * 3 + 2] = V.z;
}

const RAMP = ' .:-=+*#%@';

function grid(title, axU, axV, W = 108, H = 34) {
  // axU / axV: 取分量的下标 0=x 1=y 2=z；vSign 翻转让"上"在屏幕上方
  const [iu, iuSign] = axU;
  const [iv, ivSign] = axV;
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  const su = (W - 1) / (hi[iu] - lo[iu]);
  const sv = (H - 1) / (hi[iv] - lo[iv]);
  const cnt = new Uint32Array(W * H);
  for (let i = 0; i < n; i++) {
    const u = (P[i * 3 + iu] * iuSign - lo[iu]) * su;
    let v = (P[i * 3 + iv] * ivSign - lo[iv]) * sv;
    if (ivSign < 0) v = (hi[iv] - P[i * 3 + iv] * ivSign) * sv * -1 + 0; // 不会走到
    const cu = Math.round(u), cv = Math.round(v);
    if (cu < 0 || cu >= W || cv < 0 || cv >= H) continue;
    cnt[cv * W + cu]++;
  }
  // v 轴翻转（ASCII 第一行是顶部）
  let max = 0;
  for (const c of cnt) max = Math.max(max, c);
  const lines = [];
  for (let row = H - 1; row >= 0; row--) {
    let s = '';
    for (let col = 0; col < W; col++) {
      const c = cnt[row * W + col];
      if (!c) { s += ' '; continue; }
      const t = Math.log1p(c) / Math.log1p(max);
      s += RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(t * (RAMP.length - 2)))];
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  console.log(`\n=== ${title} ===`);
  console.log(lines.join('\n'));
}

// 侧视：横 = x（+ 右 = 车头），纵 = y（上）
grid('侧视 SIDE  ←车尾 | 车头→', [0, 1], [1, 1], 112, 30);
// 俯视：横 = x，纵 = z
grid('俯视 TOP  （上=车身左侧 +Z）', [0, 1], [2, 1], 112, 26);
// 后视：横 = z，纵 = y
grid('前视 FRONT  （横 = 车宽 Z）', [2, 1], [1, 1], 90, 26);

/* ---------- 关键剖面：宽度随 x 的变化 ---------- */
console.log('\n=== 沿车长方向的最大半宽 |z| 剖面（越低越靠地面）===');
const NB = 46;
const bins = new Float64Array(NB);
const binY = new Float64Array(NB).fill(-1);
for (let i = 0; i < n; i++) {
  const x = P[i * 3], y = P[i * 3 + 1], z = Math.abs(P[i * 3 + 2]);
  const b = Math.min(NB - 1, Math.floor(((x - box.min.x) / size.x) * NB));
  if (z > bins[b]) { bins[b] = z; binY[b] = Math.max(binY[b], y); }
}
const halfW = size.z / 2;
for (let b = 0; b < NB; b++) {
  const pct = ((b + 0.5) / NB) * 100;
  const bar = '█'.repeat(Math.round((bins[b] / halfW) * 46));
  console.log(
    `${pct.toFixed(1).padStart(5)}%  ${bins[b].toFixed(3)}  ${bar}`
  );
}
