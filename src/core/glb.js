/**
 * glb.js — GLB 加载与自动归一
 *
 * 图生 3D 出来的模型有三个不确定：尺度乱、朝向乱、不在地面上。
 * 这个模块把它们统一到"车长 X 轴、车宽 Z 轴、车底贴地"的约定里，
 * 后面的装配逻辑才有一致的坐标系可用。
 *
 * 坐标约定（全局统一）：
 *   +X = 车头方向    +Y = 上    +Z = 车身左侧
 *   车轮轴向 = Z 轴（左右两侧共用）
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const loader = new GLTFLoader();
// 静态车模/轮毂已用 Draco 压缩几何以减小体积；解码器自托管在 /draco/（不走 Google CDN，
// 避免国内访问 gstatic 超时导致模型永久卡在加载）。wasm 解码器约 188KB，一次加载后缓存。
try {
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);
} catch {
  /* 解码器加载失败时忽略，未压缩的 GLB 仍可正常解析 */
}

/**
 * 加载 GLB/GLTF。
 * @param {string} url
 * @param {{progress?: boolean}} [opts] progress=false 时不派发全局 glb:progress 事件
 *   （车库卡片等后台预览加载用，避免把主界面加载遮罩拉起来）
 * @returns {Promise<{group: THREE.Group, animations: THREE.AnimationClip[]}>}
 */
export function loadGLB(url, { progress = true } = {}) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const group = gltf.scene || gltf.scenes?.[0];
        if (!group) {
          reject(new Error('GLB 中没有可用的场景根节点'));
          return;
        }
        group.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = true;
          // 图生 3D 输出的是标准 PBR 材质，但缺清漆层 → 车漆/金属看起来发闷像塑料。
          // 升级为带 clearcoat 的物理材质，并拉高环境反射，立刻有"亮漆反光"质感。
          const list = Array.isArray(o.material) ? o.material : [o.material];
          const upgraded = list.map((m) => upgradeCarMaterial(m));
          o.material = Array.isArray(o.material) ? upgraded : upgraded[0];
        });
        resolve({ group, animations: gltf.animations || [] });
      },
      (evt) => {
        if (progress && evt.lengthComputable) {
          const pct = Math.round((evt.loaded / evt.total) * 100);
          document.dispatchEvent(
            new CustomEvent('glb:progress', { detail: { url, pct } })
          );
        }
      },
      (err) => reject(new Error(`加载 ${url} 失败：${err?.message || err}`))
    );
  });
}

/**
 * 把图生 3D 的 MeshStandardMaterial 升级为带清漆层的 MeshPhysicalMaterial，
 * 让车漆 / 金属 / 玻璃有真实的"亮漆反光 + 环境反射"质感。
 *
 * 约定：
 *   · 已是 MeshPhysicalMaterial → 只把 envMapIntensity 拉到 ≥1.3，不重复包裹；
 *   · 非 PBR 的基础材质（纯色 / 不受光）→ 原样保留，避免破坏特殊效果；
 *   · 粗糙度 < 0.7 的表面（车漆 / 金属 / 玻璃）加 clearcoat，轮胎等粗糙橡胶跳过。
 *
 * @param {THREE.Material} m
 * @returns {THREE.Material}
 */
function upgradeCarMaterial(m) {
  if (!m) return m;
  if (m.isMeshPhysicalMaterial) {
    m.envMapIntensity = Math.max(m.envMapIntensity || 1, 1.3);
    return m;
  }
  if (!m.isMeshStandardMaterial) return m;

  const p = new THREE.MeshPhysicalMaterial();
  p.color.copy(m.color);
  p.map = m.map;
  p.roughness = m.roughness;
  p.metalness = m.metalness;
  p.roughnessMap = m.roughnessMap;
  p.metalnessMap = m.metalnessMap;
  p.normalMap = m.normalMap;
  if (m.normalScale) p.normalScale.copy(m.normalScale);
  p.aoMap = m.aoMap;
  p.aoMapIntensity = m.aoMapIntensity ?? 1;
  p.emissive.copy(m.emissive);
  p.emissiveMap = m.emissiveMap;
  p.emissiveIntensity = m.emissiveIntensity ?? 1;
  p.envMapIntensity = 1.3;

  // 车漆/清漆质感：中低粗糙度表面加一层清漆，立刻有"亮漆"观感
  if (m.roughness < 0.7) {
    p.clearcoat = 1.0;
    p.clearcoatRoughness = 0.08;
  }

  m.dispose(); // 释放旧材质，避免显存泄漏
  return p;
}

/** 递归释放几何与材质 */
export function disposeObject(root) {
  root?.traverse?.((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        m[k]?.dispose?.();
      }
      m.dispose?.();
    }
  });
}

/** 取世界包围盒 */
export function boxOf(obj) {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

/* ------------------------------------------------------------------ */
/*                            整车归一                                 */
/* ------------------------------------------------------------------ */

/**
 * 整车归一：长轴对齐到 X → 等比缩放至指定车长 → XZ 居中 → 车底贴地。
 * @param {THREE.Object3D} g
 * @param {{targetLength?:number, groundY?:number}} opts
 * @returns {{size: THREE.Vector3, box: THREE.Box3}}
 */
/**
 * 推断整车包围盒的 (长, 宽, 高) 分别落在哪根轴上。
 *
 * 为什么需要：图生 3D 输出的朝向完全随机——实测同一个模型是
 * 「长=X、宽=Y、高=Z」（车身侧躺），而常见的假设「高=Y」会直接把车立起来，
 * 轮子坐标、轮距、轮拱位置全部跟着错。这是"适配不准"的头号根因。
 *
 * 判据用轿车的外形比例经验区间（对跑车/SUV/两厢车都成立）：
 *   L/W ∈ [2.0, 3.2]     L/H ∈ [2.8, 4.2]     W/H ∈ [1.1, 1.9]
 * 六根轴的分配方式全枚举，取偏离最小的。
 *
 * @param {THREE.Vector3} size 包围盒尺寸
 * @returns {{L:number,H:number,W:number,score:number,Lv:number,Wv:number,Hv:number}}
 */
export function detectCarAxes(size) {
  const s = [size.x, size.y, size.z];
  const combos = [
    { L: 0, W: 1, H: 2 }, { L: 0, W: 2, H: 1 },
    { L: 1, W: 0, H: 2 }, { L: 1, W: 2, H: 0 },
    { L: 2, W: 0, H: 1 }, { L: 2, W: 1, H: 0 },
  ];
  let best = null;
  for (const c of combos) {
    const L = s[c.L];
    const W = s[c.W];
    const H = s[c.H];
    if (!(L > 0 && W > 0 && H > 0)) continue;
    const score =
      rangePenalty(L / W, 1.6, 3.8) +
      rangePenalty(L / H, 2.5, 5.5) +
      rangePenalty(W / H, 1.0, 2.0);
    if (!best || score < best.score) best = { ...c, score, Lv: L, Wv: W, Hv: H };
  }
  // 二级兜底：若最高分组合的"长边"和"宽边"接近（L/W < 1.5）或"长边"和"高边"
  // 接近（L/H < 2.5），说明原始模型三轴相近、启发式判不准，
  // 此时退回「X=长、Y=高、Z=宽」的最朴素约定，让后续旋转和非等比校正去处理。
  if (best && (best.Lv / best.Wv < 1.3 || best.Lv / best.Hv < 2.0)) {
    best = { L: 0, W: 2, H: 1, score: best.score + 0.5, Lv: s[0], Wv: s[2], Hv: s[1] };
  }
  return best || { L: 0, W: 2, H: 1, score: 99, Lv: s[0], Wv: s[2], Hv: s[1] };
}

/** 落在 [lo,hi] 内不扣分，超出按区间宽度归一化 */
function rangePenalty(v, lo, hi) {
  if (v >= lo && v <= hi) return 0;
  const d = v < lo ? lo - v : v - hi;
  return d / (hi - lo || 1);
}

/** 排列奇偶性（用于保证旋转矩阵行列式为 +1，不产生镜像） */
function permSign(a) {
  let s = 1;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (a[i] > a[j]) s = -s;
  return s;
}

/**
 * 把模型旋转到约定朝向：长→X，高→Y，宽→Z。
 * @param {THREE.Object3D} g
 * @param {{L:number,W:number,H:number}} axes detectCarAxes 的结果
 */
export function applyCarOrientation(g, axes) {
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(0, 0, 1);

  const img = [null, null, null];
  img[axes.L] = X.clone();
  img[axes.H] = Y.clone();
  // 剩下那根轴的方向由右手系唯一确定，避免变成镜像
  const sign = permSign([axes.L, axes.H, axes.W]);
  img[axes.W] = Z.clone().multiplyScalar(sign);

  const m = new THREE.Matrix4().makeBasis(img[0], img[1], img[2]);
  g.quaternion.setFromRotationMatrix(m);
  g.updateMatrixWorld(true);
}

export function normalizeCar(
  g,
  { targetLength = 4.6, targetWidth = null, targetHeight = null, groundY = 0 } = {}
) {
  g.updateMatrixWorld(true);

  // 1) 先把模型摆正（长→X、高→Y、宽→Z），图生 3D 的朝向完全不可信
  const axes = detectCarAxes(boxOf(g).getSize(new THREE.Vector3()));
  applyCarOrientation(g, axes);
  let size = boxOf(g).getSize(new THREE.Vector3());

  // 2) 等比缩放到目标车长
  if (size.x > 0.05) {
    g.scale.multiplyScalar(targetLength / size.x);
    g.updateMatrixWorld(true);
  }
  size = boxOf(g).getSize(new THREE.Vector3());

  /* 2b) 按真车宽/高做非等比校正。
   * 等比缩放只锁得住车长——图生 3D 模型自身的长宽高比例并不等于真车。
   * 想让整体比例贴近真车，必须按真实宽高校正另外两轴。
   * 仅在调用方给出真车数据时启用，没给就保持纯等比（不引入畸变风险）。 */
  const corr = new THREE.Vector3(1, 1, 1);
  if (targetWidth > 0.05 && size.z > 0.05) corr.z = targetWidth / size.z;
  if (targetHeight > 0.05 && size.y > 0.05) corr.y = targetHeight / size.y;
  if (corr.y !== 1 || corr.z !== 1) {
    g.scale.multiply(corr);
    g.updateMatrixWorld(true);
  }

  // 3) 居中 + 贴地
  const box = boxOf(g);
  g.position.x -= (box.min.x + box.max.x) / 2;
  g.position.z -= (box.min.z + box.max.z) / 2;
  g.position.y -= box.min.y - groundY;
  g.updateMatrixWorld(true);

  return {
    size: boxOf(g).getSize(new THREE.Vector3()),
    box: boxOf(g),
    axes,
  };
}

/** 整车绕自身中心转 90° 步进（图生 3D 朝向不定，交给用户一键调正） */
export function rotateCar(g, quarters = 1, groundY = 0) {
  if (!g) return;
  g.rotation.y += (quarters * Math.PI) / 2;
  g.updateMatrixWorld(true);
  const box = boxOf(g);
  g.position.x -= (box.min.x + box.max.x) / 2;
  g.position.z -= (box.min.z + box.max.z) / 2;
  g.position.y -= box.min.y - groundY;
  g.updateMatrixWorld(true);
}

/* ------------------------------------------------------------------ */
/*                            轮毂归一                                 */
/* ------------------------------------------------------------------ */

/**
 * 轮毂归一：几何中心归零 → 轴向对齐到 Z → 量出直径与宽度。
 *
 * 不做缩放：只"量尺"，真实缩放交给 wheelRig 按滑杆目标值计算。
 * 这样无论模型里是裸轮辋还是带胎总成，最终都能被 J 值和直径滑杆校正到位。
 *
 * @param {THREE.Object3D} g
 * @returns {{diameter:number, width:number, size:THREE.Vector3}}
 */
export function normalizeWheel(g) {
  g.updateMatrixWorld(true);

  // 关键修复：图生 3D 的轮毂 GLB 各组节点自带变换，若用 `g.position.sub(center)`
  // 把几何平移到原点，组的「本地原点」仍停在旧位置——wheelRig 里给左轮做的
  // `model.rotation.y = π` 会绕着这个偏心原点旋转，导致左轮被整体甩偏
  // （轮胎与轮毂不重合、左右不一致、中心孔看着大小不一）。
  // 解决：把世界变换「烘焙」进几何体本身，清空组的变换，让组的本地原点
  // 真正等于轮心。之后任何绕原点的旋转 / 缩放都关于轮心对称。
  const parts = [];
  g.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const geo = o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld); // 烘焙自身及所有父级的世界变换
      parts.push({ geo, material: o.material });
    }
  });
  // 重建为身份变换的根：直接挂回烘焙好的网格
  for (let i = g.children.length - 1; i >= 0; i--) g.remove(g.children[i]);
  for (const p of parts) {
    const m = new THREE.Mesh(p.geo, p.material);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  g.position.set(0, 0, 0);
  g.rotation.set(0, 0, 0);
  g.scale.set(1, 1, 1);

  // 1) 几何中心移到原点：直接平移几何 → 组的本地原点 == 轮心
  let box = boxOf(g);
  const center = box.getCenter(new THREE.Vector3());
  g.traverse((o) => {
    if (o.isMesh) o.geometry.translate(-center.x, -center.y, -center.z);
  });
  g.updateMatrixWorld(true);

  // 2) 轴向对齐到 Z（绕原点旋转；几何已居中，旋转后仍居中，无需再平移）
  box = boxOf(g);
  const size = box.getSize(new THREE.Vector3());
  const dims = [
    { axis: 'x', v: size.x },
    { axis: 'y', v: size.y },
    { axis: 'z', v: size.z },
  ].sort((a, b) => a.v - b.v);
  const axle = dims[0].axis;
  const Rx = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const Ry = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
  if (axle === 'x') {
    g.traverse((o) => {
      if (o.isMesh) o.geometry.applyMatrix4(Ry);
    });
  } else if (axle === 'y') {
    g.traverse((o) => {
      if (o.isMesh) o.geometry.applyMatrix4(Rx);
    });
  }
  g.updateMatrixWorld(true);

  // 3) 量取最终尺寸（组已是身份变换，bbox 即几何真实尺寸）
  box = boxOf(g);
  const size2 = box.getSize(new THREE.Vector3());
  const diameter = Math.max(size2.x, size2.y); // 盘面直径（X/Y 应基本相等）
  const width = size2.z; // 沿轴向的宽度

  return { diameter, width, size: size2 };
}
