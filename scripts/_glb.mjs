/**
 * _glb.mjs — Node 侧的 GLB 读取（**带 node 变换**），临时诊断脚本共用
 *
 * 为什么必须单独写：
 *   public/models/my-car.glb 的场景节点带一个
 *       "rotation": [0.7071068, 0, 0, 0.7071068]     // = 绕 X 轴 +90°
 *   这是导出器做的 **Z-up → Y-up** 转换：原始网格是 Z-up（raw 包围盒
 *   1.184 × 0.538 × 0.350，高在 Z 轴且 z ∈ [−0.350, 0]，即车「挂」在 z=0 下面），
 *   节点旋转把 −Z 映到 +Y，车才正过来坐在 y=0 上。
 *
 *   浏览器里 GLTFLoader 会自动应用这个节点变换；
 *   而直接读 POSITION 再 `new Mesh(geo)` 的 Node 脚本不会 ——
 *   结果就是 **Node 里的车是上下颠倒的**，
 *   按 y 分层的统计（C1 底切、轮拱高度、bodyHalfWidth 测量带）全部错位。
 *
 *   本模块按 glTF 规范重建节点世界矩阵，把变换烘进顶点，
 *   让 Node 侧几何与浏览器逐点一致。
 *
 * 用法：const { pos, idx } = readGLBWorld(file)
 */

import fs from 'node:fs';

/** glTF 节点 TRS → 4×4 列主序矩阵（与 THREE.Matrix4.compose 一致） */
function nodeMatrix(node) {
  let m = identity();
  if (node.matrix) return node.matrix.slice();
  if (node.scale) m = mul(m, scaleM(node.scale));
  if (node.rotation) m = mul(m, quatM(node.rotation));
  if (node.translation) m = mul(m, transM(node.translation));
  return m;
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const transM = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
const scaleM = (s) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];

/** 四元数 [x,y,z,w] → 旋转矩阵（列主序） */
function quatM(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

/** 列主序 4×4 相乘：a × b */
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = v;
    }
  }
  return o;
}

/** 列主序矩阵 × 点 */
function xform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function parseGLB(file) {
  const data = fs.readFileSync(file);
  let off = 12;
  const chunks = [];
  while (off < data.length) {
    const len = data.readUInt32LE(off);
    const type = data.readUInt32LE(off + 4);
    chunks.push([type, data.subarray(off + 8, off + 8 + len)]);
    off += 8 + len;
  }
  const jsonChunk = chunks.find((c) => c[0] === 0x4e4f534a);
  if (!jsonChunk) throw new Error('不是合法的 GLB（找不到 JSON chunk）');
  const json = JSON.parse(jsonChunk[1].toString('utf8'));
  const bin = chunks.find((c) => c[0] !== 0x4e4f534a)?.[1] ?? Buffer.alloc(0);

  const acc = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const o = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const n = { VEC3: 3, VEC2: 2, SCALAR: 1 }[a.type];
    const base = bin.byteOffset + o;
    if (base % 4 === 0) {
      if (a.componentType === 5126) return new Float32Array(bin.buffer, base, a.count * n);
      if (a.componentType === 5125) return new Uint32Array(bin.buffer, base, a.count * n);
      return new Uint16Array(bin.buffer, base, a.count * n);
    }
    const copy = new Uint8Array(bin);
    if (a.componentType === 5126) return new Float32Array(copy.buffer, o, a.count * n);
    if (a.componentType === 5125) return new Uint32Array(copy.buffer, o, a.count * n);
    return new Uint16Array(copy.buffer, o, a.count * n);
  };
  return { json, acc };
}

/**
 * 读取 GLB，把所有 mesh 顶点按节点世界矩阵变换后合并，
 * 返回与浏览器 GLTFLoader 一致的几何。
 *
 * @param {string} file
 * @returns {{pos:Float32Array, idx:Uint32Array, nodes:number}}
 */
export function readGLBWorld(file) {
  const { json, acc } = parseGLB(file);
  const nodes = json.nodes || [];
  const scene = json.scenes?.[0] || { nodes: nodes.map((_, i) => i) };

  // 每个节点的本地矩阵
  const local = nodes.map((n) => nodeMatrix(n));
  // 递归算世界矩阵（parent 链）
  const world = new Array(nodes.length).fill(null);
  const worldOf = (i) => {
    if (world[i]) return world[i];
    const p = nodes[i].children || [];
    let m = local[i];
    world[i] = m;
    for (const c of p) {
      // 子节点世界 = 父世界 × 子本地
      const cw = worldOf(c);
      world[c] = mul(m, cw);
    }
    return m;
  };
  for (let i = 0; i < nodes.length; i++) worldOf(i);

  const P = [];
  const I = [];
  let meshCount = 0;

  const visit = (nodeIdx, parentWorld) => {
    const n = nodes[nodeIdx];
    const m = mul(parentWorld, local[nodeIdx]);
    if (n.mesh !== undefined) {
      meshCount++;
      for (const prim of json.meshes[n.mesh].primitives || []) {
        const pa = acc(prim.attributes.POSITION);
        const base = P.length / 3;
        for (let i = 0; i < pa.length; i += 3) {
          const v = xform(m, [pa[i], pa[i + 1], pa[i + 2]]);
          P.push(v[0], v[1], v[2]);
        }
        const ia = prim.indices !== undefined ? acc(prim.indices) : null;
        if (ia) for (let i = 0; i < ia.length; i++) I.push(ia[i] + base);
        else for (let i = 0; i < pa.length / 3; i++) I.push(i + base);
      }
    }
    for (const c of n.children || []) visit(c, m);
  };

  const root = identity();
  for (const i of scene.nodes || []) visit(i, root);

  return { pos: new Float32Array(P), idx: new Uint32Array(I), nodes: nodes.length, meshes: meshCount };
}

/** 只取 accessor 的原始数组，不做变换（对比用） */
export function readGLBRaw(file) {
  const { json, acc } = parseGLB(file);
  const P = [];
  const I = [];
  for (const m of json.meshes || [])
    for (const p of m.primitives || []) {
      const pa = acc(p.attributes.POSITION);
      const base = P.length / 3;
      for (let i = 0; i < pa.length; i++) P.push(pa[i]);
      const ia = p.indices !== undefined ? acc(p.indices) : null;
      if (ia) for (let i = 0; i < ia.length; i++) I.push(ia[i] + base);
      else for (let i = 0; i < pa.length / 3; i++) I.push(i + base);
    }
  return { pos: new Float32Array(P), idx: new Uint32Array(I) };
}
