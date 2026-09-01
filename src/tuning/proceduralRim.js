/**
 * proceduralRim.js — 兜底程序化轮毂 + 真实轮毂预设
 *
 * 预设款式（RIM_PRESETS）现在优先指向真实 GLB 轮毂模型（/models/rim-*.glb）。
 * buildProceduralRim 仅作为真实模型加载失败 / 未上传时的兜底，保证预览永远可用。
 * 所有预设轴向对齐 Z，切换后 ET/J/倾角/尺寸调节仍然生效。
 */

import * as THREE from 'three';

export const RIM_PRESETS = [
  { id: 'default', label: '五辐锻造', style: 'default', spokes: 5, glbUrl: '/models/rim-default.glb' },
  { id: 'te37', label: 'TE37 · 六辐', style: 'te37', spokes: 6, glbUrl: '/models/rim-te37.glb' },
  { id: 'bbs-lm', label: 'BBS LM · 双叉', style: 'bbs-lm', spokes: 10, glbUrl: '/models/rim-bbs-lm.glb' },
  { id: 'rotiform', label: 'Rotiform · 深唇', style: 'rotiform', spokes: 7, glbUrl: '/models/rim-rotiform.glb' },
  { id: 'mesh', label: 'Mesh · 密辐', style: 'mesh', spokes: 16, glbUrl: '/models/rim-mesh.glb' },
  { id: 'sport', label: '运动 · 双五辐', style: 'sport', spokes: 10, glbUrl: '/models/rim-sport.glb' },
];

/**
 * 按风格向 pivot（已绕 Z 轴旋转到对应角度）添加一根/一组辐条。
 */
function addSpokeByStyle(pivot, style, { R, width, halfW, rimMat, darkMat, i, spokeCount }) {
  const makeBox = (w, h, d, x, y, z, mat = rimMat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    pivot.add(m);
    return m;
  };

  switch (style) {
    case 'te37': {
      // 经典 6 辐：梯形粗辐条，外端宽、内端窄，带内凹
      const len = R * 0.66;
      const wOut = R * 0.16;
      const wIn = R * 0.10;
      const spokeShape = new THREE.Shape();
      spokeShape.moveTo(-wIn / 2, 0);
      spokeShape.lineTo(wIn / 2, 0);
      spokeShape.lineTo(wOut / 2, len);
      spokeShape.lineTo(-wOut / 2, len);
      spokeShape.lineTo(-wIn / 2, 0);
      const geo = new THREE.ExtrudeGeometry(spokeShape, { depth: width * 0.38, bevelEnabled: false, curveSegments: 8 });
      const m = new THREE.Mesh(geo, rimMat);
      m.position.z = -width * 0.18;
      m.castShadow = true;
      pivot.add(m);
      break;
    }
    case 'bbs-lm': {
      // 经典 BBS LM：每组两根细叉辐条，5 组共 10 根
      const pairOffset = Math.PI / spokeCount; // 半组夹角
      const len = R * 0.62;
      const w = R * 0.045;
      const d = width * 0.34;
      [-1, 1].forEach((side) => {
        const sub = new THREE.Group();
        sub.rotation.z = side * pairOffset * 0.32;
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), rimMat);
        m.position.set(0, len * 0.52, -width * 0.14);
        m.castShadow = true;
        sub.add(m);
        pivot.add(sub);
      });
      break;
    }
    case 'rotiform': {
      // Rotiform 深唇：粗 Y 形辐条，外端分叉并接深唇
      const len = R * 0.68;
      const w = R * 0.13;
      const d = width * 0.44;
      // 主辐条
      makeBox(w, len, d, 0, len * 0.48, -width * 0.12);
      // 外端两侧小叉
      [-1, 1].forEach((side) => {
        const branch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.55, len * 0.35, d * 0.8), rimMat);
        branch.position.set(side * w * 0.55, len * 0.78, -width * 0.12);
        branch.rotation.z = side * 0.28;
        branch.castShadow = true;
        pivot.add(branch);
      });
      break;
    }
    case 'mesh': {
      // 密辐 Mesh：细辐条 + 外圈细环连接
      const len = R * 0.60;
      const w = R * 0.035;
      const d = width * 0.28;
      makeBox(w, len, d, 0, len * 0.52, -width * 0.10);
      // 外圈环片段
      if (i % 2 === 0) {
        const ringSeg = new THREE.Mesh(
          new THREE.TorusGeometry(R * 0.82, R * 0.018, 8, 32, (Math.PI * 2) / spokeCount),
          rimMat
        );
        ringSeg.position.z = -width * 0.10;
        ringSeg.castShadow = true;
        pivot.add(ringSeg);
      }
      break;
    }
    case 'sport': {
      // 运动双五辐：每组两根，外端分叉
      const len = R * 0.66;
      const w = R * 0.075;
      const d = width * 0.40;
      [-1, 1].forEach((side) => {
        const sub = new THREE.Group();
        sub.rotation.z = side * 0.14;
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), rimMat);
        m.position.set(0, len * 0.50, -width * 0.12);
        m.castShadow = true;
        sub.add(m);
        pivot.add(sub);
      });
      break;
    }
    default: {
      // 默认五辐锻造：宽辐条，带内凹
      const len = R * 0.72;
      const w = R * 0.15;
      const d = width * 0.50;
      makeBox(w, len, d, 0, len * 0.40, -width * 0.12);
      break;
    }
  }
}

/**
 * @param {{diameter?:number, width?:number, spokes?:number, style?:string}} opts 单位：米
 * @returns {THREE.Group} 已居中、轴向为 Z 的轮毂
 */
export function buildProceduralRim({ diameter = 0.48, width = 0.216, spokes = 5, style = 'default' } = {}) {
  const g = new THREE.Group();
  g.name = 'procedural-rim';

  const R = diameter / 2;
  const lipR = R * 0.99;
  const barrelR = R * 0.86;
  const halfW = width / 2;

  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xc9ced6,
    metalness: 0.95,
    roughness: 0.24,
    envMapIntensity: 1.3,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1b1e24,
    metalness: 0.7,
    roughness: 0.45,
  });

  // 轮辋筒身（外侧窄、内侧宽的锥度）
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(lipR, barrelR, width, 64, 1, true),
    darkMat
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.castShadow = true;
  g.add(barrel);

  // 外唇缘
  const lip = new THREE.Mesh(new THREE.TorusGeometry(lipR * 0.995, R * 0.028, 12, 72), rimMat);
  lip.position.z = halfW - R * 0.02;
  lip.castShadow = true;
  g.add(lip);

  // 内唇缘
  const lipIn = lip.clone();
  lipIn.position.z = -halfW + R * 0.02;
  g.add(lipIn);

  // 辐条：按 style 生成不同经典款式
  const spokeCount = spokes;
  const effectiveStyle = RIM_PRESETS.find((p) => p.style === style)?.style || 'default';
  for (let i = 0; i < spokeCount; i++) {
    const angle = (i / spokeCount) * Math.PI * 2;
    const pivot = new THREE.Group();
    pivot.rotation.z = angle;
    addSpokeByStyle(pivot, effectiveStyle, { R, width, halfW, rimMat, darkMat, i, spokeCount });
    g.add(pivot);
  }

  // 中心盘 + 中心孔
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.24, R * 0.26, width * 0.34, 40), rimMat);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = halfW - width * 0.16;
  hub.castShadow = true;
  g.add(hub);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.15, R * 0.15, 0.012, 32), darkMat);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = halfW - width * 0.16 + width * 0.18;
  g.add(cap);

  // 螺栓（5 孔示例）
  const boltGeo = new THREE.CylinderGeometry(R * 0.032, R * 0.032, width * 0.1, 12);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 5;
    const b = new THREE.Mesh(boltGeo, darkMat);
    b.rotation.x = Math.PI / 2;
    b.position.set(Math.cos(a) * R * 0.18, Math.sin(a) * R * 0.18, halfW - width * 0.08);
    g.add(b);
  }

  return g;
}
