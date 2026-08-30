/**
 * tire.js — 程序化轮胎（LatheGeometry 车削成型）
 *
 * 图生 3D 出来的通常是"裸轮辋"，直接装上会悬空。
 * 这里按 (轮辋直径 / 胎宽 / 扁平比) 车削出一条真轮胎：
 *   外径 = 轮辋直径 + 2 × 断面高    断面高 = 胎宽 × 扁平比
 * 符合改装第一原则——改扁平比时轮胎外径随断面高变化，轮辋可见尺寸随之改变。
 */

import * as THREE from 'three';

/**
 * 生成轮胎网格。返回的网格轴向已对齐到 Z，可直接塞进车轮组。
 * @param {{rimRadius:number, sectionWidth:number, aspect:number}} spec 单位：米 / 米 / 百分比
 * @returns {THREE.Mesh}
 */
export function buildTire({ rimRadius, sectionWidth, aspect }) {
  const R = rimRadius + sectionWidth * (aspect / 100); // 轮胎外半径
  const halfW = sectionWidth / 2;
  const shoulder = Math.min(0.03, (R - rimRadius) * 0.5, halfW * 0.85);

  const pts = [];
  const V = (r, a) => pts.push(new THREE.Vector2(Math.max(0.001, r), a));

  // 内侧胎壁（略带外鼓，像真胎）
  V(rimRadius, -halfW);
  V(rimRadius + (R - rimRadius) * 0.45, -halfW * 1.05);
  // 内侧胎肩圆角
  const cx1 = R - shoulder;
  const cy1 = -halfW + shoulder;
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * (Math.PI / 2);
    V(cx1 + shoulder * Math.cos(a), cy1 + shoulder * Math.sin(a));
  }
  // 胎面：走一遍并刻出浅沟。
  // 起止点由两侧胎肩圆弧提供，这里只取内部点，避免出现重合顶点（会导致法线 NaN）
  const treadStart = -halfW + shoulder;
  const span = (halfW - shoulder) - treadStart;
  const grooves = 12;
  for (let i = 1; i < grooves; i++) {
    const t = i / grooves;
    const r = i % 2 === 1 ? R - 0.005 : R; // 浅沟 5mm
    V(r, treadStart + span * t);
  }
  // 外侧胎肩圆角
  const cx2 = R - shoulder;
  const cy2 = halfW - shoulder;
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    V(cx2 + shoulder * Math.cos(a), cy2 + shoulder * Math.sin(a));
  }
  // 外侧胎壁
  V(rimRadius + (R - rimRadius) * 0.45, halfW * 1.05);
  V(rimRadius, halfW);

  const geo = new THREE.LatheGeometry(pts, 72);
  geo.rotateX(Math.PI / 2); // 车削轴 Y → 车轮轴向 Z
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x15171b,
    roughness: 0.9,
    metalness: 0.0,
    envMapIntensity: 0.35,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'tire';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 由 (轮辋英寸, 胎宽mm, 扁平比) 推算轮胎外半径（米） */
export function tireOuterRadius(rimInch, tireWidthMm, aspect) {
  const rimR = (rimInch * 25.4) / 2000;
  return rimR + (tireWidthMm / 1000) * (aspect / 100);
}
