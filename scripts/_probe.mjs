import fs from 'node:fs';
import * as THREE from 'three';

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

const { normalizeCar } = await import('../src/core/glb.js');
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

// 世界坐标三角形质心
const m = carOuter.children[0].children[0].matrixWorld;
const V = new THREE.Vector3();
const tri = indices.length / 3;
const cx = new Float32Array(tri), cy = new Float32Array(tri), cz = new Float32Array(tri);
for (let t = 0; t < tri; t++) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 3; k++) {
    V.fromBufferAttribute(geo.attributes.position, indices[t * 3 + k]).applyMatrix4(m);
    x += V.x; y += V.y; z += V.z;
  }
  cx[t] = x / 3; cy[t] = y / 3; cz[t] = z / 3;
}

function band(label, lo, hi) {
  const W = 80, H = 24;
  const grid = new Int32Array(W * H);
  let n = 0;
  for (let t = 0; t < tri; t++) {
    if (cy[t] < lo || cy[t] > hi) continue;
    const u = (cx[t] - box.min.x) / size.x;
    const v = (cz[t] - box.min.z) / size.z;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    grid[Math.min(H - 1, Math.floor(v * (H - 1))) * W + Math.min(W - 1, Math.floor(u * (W - 1)))]++;
    n++;
  }
  const mx = Math.max(...grid) || 1;
  const ramp = ' .:-=+*#%@';
  console.log(`\n${label}  (高 ${lo.toFixed(3)}~${hi.toFixed(3)}m, ${n} 面)`);
  for (let r = 0; r < H; r++) {
    let line = '';
    for (let c = 0; c < W; c++) {
      const v = grid[r * W + c];
      line += v === 0 ? ' ' : ramp[Math.min(9, 1 + Math.floor((v / mx) * 8))];
    }
    console.log('|' + line + '|');
  }
}

const H = size.y;
band('【接地带】y ∈ [0, 3%H]', box.min.y, box.min.y + H * 0.03);
band('【低带】y ∈ [0, 8%H]', box.min.y, box.min.y + H * 0.08);
band('【轮心带】y ∈ [15%, 35%H]', box.min.y + H * 0.15, box.min.y + H * 0.35);
band('【中带】y ∈ [25%, 50%H]', box.min.y + H * 0.25, box.min.y + H * 0.5);
