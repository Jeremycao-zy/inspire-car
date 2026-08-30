/**
 * _probe-connected-parts.mjs — 探测车模的连通域结构，判断"能不能本地拆出车轮"
 *
 * 目的：BANG 拆解要 $120/月的 Business 订阅。在掏钱之前，先确认一件事——
 * 生成的车模里，车轮本身是不是就是独立的几何连通块？
 * 如果是，本地做连通域分割就能拆，BANG 全省了。
 *
 * 纯 Node 实现（自己解析 GLB，不用 three.js / 不用浏览器）：
 *   1. 解析 GLB → JSON + BIN
 *   2. 按节点世界矩阵把顶点变换到世界坐标
 *   3. 按量化坐标焊接顶点（让"接触"的部件连成一块）
 *   4. 并查集求全局连通分量
 *   5. 输出每个分量的包围盒 / 质心 / 三角面数，并按"车轮特征"打分
 *
 * 用法：node scripts/_probe-connected-parts.mjs [glb路径]
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------- GLB 解析 ------------------------- */

function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件');
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'JSON') json = JSON.parse(data.toString('utf8'));
    else if (type.startsWith('BIN')) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error('缺少 JSON chunk');
  return { json, bin: bin || Buffer.alloc(0) };
}

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const comp = COMP[acc.componentType];
  const n = NCOMP[acc.type];
  if (!acc.bufferView && acc.bufferView !== 0) return null;
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const out = new comp(acc.count * n);
  if (!stride || stride === comp.BYTES_PER_ELEMENT * n) {
    const src = bin.subarray(base, base + acc.count * n * comp.BYTES_PER_ELEMENT);
    // 拷贝一份，避免字节序/对齐问题
    const tmp = new comp(src.buffer, src.byteOffset, acc.count * n);
    out.set(tmp);
  } else {
    for (let i = 0; i < acc.count; i++) {
      const o = base + i * stride;
      const tmp = new comp(bin.buffer, bin.byteOffset + o, n);
      out.set(tmp, i * n);
    }
  }
  return out;
}

/* ------------------------- 4x4 矩阵（列主序，同 glTF） ------------------------- */

const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

function fromTRS(t, r, s) {
  // r 是四元数 [x,y,z,w]
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function apply(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function nodeMatrices(json) {
  const mats = json.nodes.map(() => null);
  const walk = (i, parent) => {
    const n = json.nodes[i];
    let local = I4();
    if (n.matrix) local = n.matrix.slice();
    else local = fromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
    const world = parent ? mul(parent, local) : local;
    mats[i] = world;
    for (const c of n.children || []) walk(c, world);
  };
  const roots = [];
  const hasParent = new Set();
  for (const n of json.nodes) for (const c of n.children || []) hasParent.add(c);
  json.nodes.forEach((_, i) => { if (!hasParent.has(i)) roots.push(i); });
  // scene 优先
  const scene = json.scenes?.[json.scene ?? 0];
  const rootList = scene?.nodes?.length ? scene.nodes : roots;
  for (const r of rootList) walk(r, null);
  // 兜底：没被遍历到的节点
  json.nodes.forEach((_, i) => { if (!mats[i]) mats[i] = I4(); });
  return mats;
}

/* ------------------------- 并查集 ------------------------- */

class DSU {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; this.r = new Uint8Array(n); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.r[ra] < this.r[rb]) this.p[ra] = rb;
    else if (this.r[ra] > this.r[rb]) this.p[rb] = ra;
    else { this.p[rb] = ra; this.r[ra]++; }
  }
}

/* ------------------------- 主流程 ------------------------- */

const file = process.argv[2] || 'public/models/my-car.glb';
const abs = path.resolve(file);
console.log(`\n分析：${abs}`);
console.log(`大小：${(fs.statSync(abs).size / 1024 / 1024).toFixed(1)} MB\n`);

const { json, bin } = parseGLB(fs.readFileSync(abs));
const mats = nodeMatrices(json);

// 焊接顶点：量化到 0.1mm，跨整个模型共享，接触的部件才会连成一块
const Q = 1e4; // 0.1mm
const weld = new Map();
const weldPos = [];

const weldVertex = (x, y, z) => {
  const k = `${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`;
  let id = weld.get(k);
  if (id === undefined) {
    id = weldPos.length / 3;
    weld.set(k, id);
    weldPos.push(x, y, z);
  }
  return id;
};

const tris = []; // 扁平化三角形顶点 id
const triCountPerMesh = [];

for (let ni = 0; ni < json.nodes.length; ni++) {
  const node = json.nodes[ni];
  if (node.mesh === undefined || node.mesh === null) continue;
  const m = mats[ni];
  const mesh = json.meshes[node.mesh];
  for (const prim of mesh.primitives || []) {
    if (prim.mode !== undefined && prim.mode !== 4) continue; // 只要三角面
    const posAcc = prim.attributes?.POSITION;
    if (posAcc === undefined) continue;
    const pos = readAccessor(json, bin, posAcc);
    if (!pos) continue;

    let idx = null;
    if (prim.indices !== undefined && prim.indices !== null) idx = readAccessor(json, bin, prim.indices);
    const count = idx ? idx.length : pos.length / 3;

    let before = tris.length / 3;
    for (let i = 0; i < count; i++) {
      const vi = idx ? idx[i] : i;
      const p = apply(m, [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]);
      tris.push(weldVertex(p[0], p[1], p[2]));
    }
    triCountPerMesh.push((tris.length / 3 - before));
  }
}

const nTri = tris.length / 3;
const nVert = weldPos.length / 3;
console.log(`顶点（焊接后）：${nVert.toLocaleString()}`);
console.log(`三角面：${nTri.toLocaleString()}`);

// 并查集：同一三角形的三个顶点连通
const dsu = new DSU(nVert);
for (let t = 0; t < nTri; t++) {
  const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
  dsu.union(a, b); dsu.union(b, c);
}

// 汇总每个连通分量
const comps = new Map();
for (let t = 0; t < nTri; t++) {
  const root = dsu.find(tris[t * 3]);
  let c = comps.get(root);
  if (!c) { c = { root, tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sx: 0, sy: 0, sz: 0 }; comps.set(root, c); }
  c.tris++;
  for (let k = 0; k < 3; k++) {
    const vi = tris[t * 3 + k];
    const x = weldPos[vi * 3], y = weldPos[vi * 3 + 1], z = weldPos[vi * 3 + 2];
    c.min[0] = Math.min(c.min[0], x); c.max[0] = Math.max(c.max[0], x);
    c.min[1] = Math.min(c.min[1], y); c.max[1] = Math.max(c.max[1], y);
    c.min[2] = Math.min(c.min[2], z); c.max[2] = Math.max(c.max[2], z);
    c.sx += x; c.sy += y; c.sz += z;
  }
}

const list = [...comps.values()]
  .map((c) => {
    const size = [c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]];
    const n = c.tris * 3;
    const center = [c.sx / n, c.sy / n, c.sz / n];
    return { tris: c.tris, size, center, min: c.min, max: c.max, volume: size[0] * size[1] * size[2] };
  })
  .sort((a, b) => b.tris - a.tris);

console.log(`\n连通分量数：${list.length}`);
console.log(`\n前 15 大分量（按三角面数）：`);
console.log('  #   三角面      尺寸 X×Y×Z (m)              质心 (x, y, z)         体积(m³)');
list.slice(0, 15).forEach((c, i) => {
  console.log(
    `  ${String(i + 1).padStart(2)}  ${String(c.tris).padStart(8)}   ` +
      `${c.size.map((v) => v.toFixed(3).padStart(7)).join(' × ')}   ` +
      `(${c.center.map((v) => v.toFixed(2).padStart(6)).join(', ')})   ${c.volume.toFixed(4)}`
  );
});

/* ---- 车轮特征评分 ----
 * 车轮特征：近似圆盘 —— X(直径)×Y(直径) 接近、Z(宽度)明显更小；
 * 且体积远小于车身。这里只是粗筛，给人工判断做参考。 */
console.log(`\n疑似车轮的分量（近似圆盘 + 非最大块，按相似度排序）：`);
const maxTris = list[0]?.tris || 1;
const wheelish = list
  .filter((c) => c.tris < maxTris * 0.5)
  .map((c) => {
    const [sx, sy, sz] = c.size;
    const sorted = [...c.size].sort((a, b) => b - a);
    const diameterish = (sorted[0] + sorted[1]) / 2;
    const thin = sorted[2];
    if (diameterish <= 0) return null;
    const aspect = thin / diameterish; // 越小越像盘子
    const roundness = sorted[1] / sorted[0]; // 越接近 1 越圆
    if (aspect > 0.65 || roundness < 0.55) return null;
    return { c, aspect, roundness, score: roundness * (1 - aspect) };
  })
  .filter(Boolean)
  .sort((a, b) => b.score - a.score);

if (!wheelish.length) {
  console.log('  （无）—— 说明车轮很可能与车身/底盘融成了一块，连通域分割拆不出来。');
} else {
  wheelish.slice(0, 8).forEach((w, i) => {
    console.log(
      `  ${i + 1}. 面数 ${String(w.c.tris).padStart(7)}  ` +
        `尺寸 ${w.c.size.map((v) => v.toFixed(3)).join('×')}  ` +
        `厚径比 ${w.aspect.toFixed(2)}  圆度 ${w.roundness.toFixed(2)}  ` +
        `质心 (${w.c.center.map((v) => v.toFixed(2)).join(', ')})`
    );
  });
}

console.log('');
