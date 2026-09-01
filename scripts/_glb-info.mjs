/**
 * _glb-info.mjs — 离线体检 GLB：子网格包围盒 / 材质 / 贴图主色
 *
 * 为什么需要：3D 问题（双车、模型错位、莫名变红、拆解产物不生效）
 * 光看浏览器截图只能看到表象。直接读 GLB 的 JSON chunk，能在**不开浏览器、
 * 不花云端额度**的前提下拿到确凿事实：
 *   · 文件里有几个 mesh / primitive，各自的世界包围盒与顶点数
 *   · 材质用了哪张贴图（baseColor / metallicRoughness / normal）
 *   · 贴图主色（能一眼看出"模型自带红漆"还是"代码给上的色"）
 *
 * 用法：
 *   node scripts/_glb-info.mjs .cache/models/car-xxx.glb [more.glb ...]
 *   node scripts/_glb-info.mjs --tex .cache/models/car-xxx.glb   # 额外导出贴图到 /tmp
 *
 * 判读要点：
 *   · 各 primitive 包围盒的**并集** = 模型总包围盒；两个文件并集完全相同
 *     ⇒ 它们在同一坐标系（BANG 拆解产物就属于这种情况，可以直接按原坐标装配）。
 *   · 某个子网格 min.y 明显高于总 min.y ⇒ 它不含车轮（车身件），只留它不会缺件。
 *   · baseColor 贴图主色中性、但画面里是红的 ⇒ 红色来自代码里的 material.color。
 */

import fs from 'node:fs';
import path from 'node:path';

const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = v;
    }
  }
  return out;
}

/** glTF 的 TRS → 列主序 4x4 */
function trs(tr, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    tr[0], tr[1], tr[2], 1,
  ];
}

function xform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function readChunks(buf) {
  let off = 12;
  const chunks = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type: type.trim(), len, dataStart: off + 8 });
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return chunks;
}

function analyze(file, { dumpTex }) {
  const buf = fs.readFileSync(file);
  const chunks = readChunks(buf);
  const jsonChunk = chunks.find((c) => c.type === 'JSON');
  const binChunk = chunks.find((c) => c.type === 'BIN');
  if (!jsonChunk) throw new Error('不是合法的 GLB（找不到 JSON chunk）');
  const json = JSON.parse(
    buf.slice(jsonChunk.dataStart, jsonChunk.dataStart + jsonChunk.len).toString('utf8')
  );
  const { meshes = [], nodes = [], accessors = [], materials = [], images = [] } = json;

  console.log(`\n=== ${path.basename(file)}`);
  console.log(`  mesh ${meshes.length} / node ${nodes.length} / material ${materials.length} / image ${images.length}`);

  materials.forEach((m, i) => {
    const pbr = m.pbrMetallicRoughness || {};
    const texOf = (t) => (t && t.index !== undefined ? `tex#${t.index}` : '—');
    console.log(
      `  mat[${i}] ${m.name || '(unnamed)'} baseColor=${texOf(pbr.baseColorTexture)}` +
        ` factor=${JSON.stringify(pbr.baseColorFactor || null)}` +
        ` metalRough=${texOf(pbr.metallicRoughnessTexture)} normal=${texOf(m.normalTexture)}`
    );
    if (pbr.baseColorFactor) {
      const [r, g, b] = pbr.baseColorFactor;
      const isRed = r > 0.5 && r > g * 1.6 && r > b * 1.6;
      console.log(`      ↳ baseColorFactor 判定：${isRed ? '⚠️ 自带红漆' : '非红色'}`);
    }
  });

  const out = [];
  const walk = (idx, parentM) => {
    const n = nodes[idx];
    if (!n) return;
    const m = n.matrix ? mul(parentM, n.matrix.slice()) : mul(parentM, trs(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]));
    if (n.mesh !== undefined) {
      (meshes[n.mesh]?.primitives || []).forEach((pr, pi) => {
        const acc = accessors[pr.attributes?.POSITION];
        if (!acc || !acc.min) return;
        const corners = [];
        for (const X of [acc.min[0], acc.max[0]])
          for (const Y of [acc.min[1], acc.max[1]])
            for (const Z of [acc.min[2], acc.max[2]]) corners.push(xform(m, [X, Y, Z]));
        const min = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i])));
        const max = [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i])));
        out.push({ node: n.name || `node${idx}`, prim: pi, verts: acc.count, min, max, material: pr.material });
      });
    }
    (n.children || []).forEach((c) => walk(c, m));
  };
  (json.scenes?.[0]?.nodes || [0]).forEach((i) => walk(i, I4));

  out.forEach((o) => {
    console.log(
      `  · ${o.node} p${o.prim} v=${o.verts} mat=${o.material}` +
        ` min[${o.min.map((v) => v.toFixed(3)).join(', ')}]` +
        ` max[${o.max.map((v) => v.toFixed(3)).join(', ')}]`
    );
  });
  if (out.length) {
    const min = [0, 1, 2].map((i) => Math.min(...out.map((o) => o.min[i])));
    const max = [0, 1, 2].map((i) => Math.max(...out.map((o) => o.max[i])));
    console.log(
      `  TOTAL min[${min.map((v) => v.toFixed(3)).join(', ')}]` +
        ` max[${max.map((v) => v.toFixed(3)).join(', ')}]` +
        ` size[${max.map((v, i) => (v - min[i]).toFixed(3)).join(' × ')}]`
    );
  }

  if (dumpTex && binChunk) {
    images.forEach((img, i) => {
      const bv = json.bufferViews[img.bufferView];
      if (!bv) return;
      const data = buf.slice(binChunk.dataStart + bv.byteOffset, binChunk.dataStart + bv.byteOffset + bv.byteLength);
      const ext = (img.mimeType || '').includes('png') ? 'png' : 'jpg';
      const p = `/tmp/${path.basename(file, '.glb')}-tex${i}.${ext}`;
      fs.writeFileSync(p, data);
      console.log(`  ↳ 导出贴图 ${p} (${(bv.byteLength / 1048576).toFixed(1)}MB)`);
    });
  }
}

const argv = process.argv.slice(2);
const dumpTex = argv.includes('--tex');
const files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('用法：node scripts/_glb-info.mjs [--tex] <file.glb> [...]');
  process.exit(1);
}
for (const f of files) analyze(f, { dumpTex });
