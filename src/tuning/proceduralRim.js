/**
 * proceduralRim.js — 兜底程序化轮毂
 *
 * 用户还没上传轮毂照片、或 GLB 生成失败时，用它保证预览永远有东西可看、可调。
 * 结构与真实锻造轮毂一致：轮辋筒身 + 辐条 + 中心盘 + 螺栓，轴向对齐 Z。
 */

import * as THREE from 'three';

/**
 * @param {{diameter?:number, width?:number, spokes?:number}} opts 单位：米
 * @returns {THREE.Group} 已居中、轴向为 Z 的轮毂
 */
export function buildProceduralRim({ diameter = 0.48, width = 0.216, spokes = 5 } = {}) {
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

  // 辐条：从中心盘放射到外唇，带一点内凹（concave）
  const spokeGeo = new THREE.BoxGeometry(R * 0.72, R * 0.15, width * 0.5);
  for (let i = 0; i < spokes; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.z = (i / spokes) * Math.PI * 2;
    const s = new THREE.Mesh(spokeGeo, rimMat);
    s.position.set(R * 0.38, 0, -width * 0.12); // 内凹：辐条面往里缩
    s.castShadow = true;
    pivot.add(s);
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
