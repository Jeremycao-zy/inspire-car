/**
 * wheelHolo.js — 「轮毂仓库」全息感 3D 轮毂展示器
 *
 * 用法：
 *   const v = createWheelHolo(container);
 *   v.setWheel('/api/asset/xxx.glb');   // 换成某个轮毂
 *   v.dispose();                        // 释放 WebGL 上下文
 *
 * 设计：
 *   · 单个 WebGLRenderer（一个 WebGL 上下文，对 iOS Safari 友好，不滥开上下文）。
 *   · 透明画布，轮毂「悬空」浮在 UI 之上，下方一圈发光环 + 缓慢自转 + 上下浮动。
 *   · 全息材质：青色自发光 + 半透明 + 叠加青色线框（扫描栅格感）；不追求写实反射。
 *   · 复用 src/core/glb.js 的 loadGLB（含 Draco 解码）与 normalizeWheel（居中 + 轴向对齐 Z）。
 */

import * as THREE from 'three';
import { loadGLB, normalizeWheel, disposeObject } from '../core/glb.js';

const HOLO_COLOR = 0x18e6ff;
const HOLO_EMISSIVE = 0x0bb8e6;

export function createWheelHolo(container) {
  if (!container) return null;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
  camera.position.set(0.55, 0.35, 1.15);
  camera.lookAt(0, 0, 0);

  // 灯光：全息不需要写实反射，一组青色补光 + 环境光足够
  scene.add(new THREE.AmbientLight(0x223344, 1.1));
  const key = new THREE.PointLight(HOLO_COLOR, 2.2, 10);
  key.position.set(1.2, 1.6, 1.8);
  scene.add(key);
  const rim = new THREE.PointLight(0x66aaff, 1.2, 10);
  rim.position.set(-1.4, -0.6, -1.0);
  scene.add(rim);

  // 下方发光环（halo 平台）
  const ringGeo = new THREE.TorusGeometry(0.52, 0.012, 12, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: HOLO_COLOR,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.5;
  scene.add(ring);

  // 第二圈更大的淡光环，增强"悬浮力场"观感
  const ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(0.66, 0.006, 12, 64),
    new THREE.MeshBasicMaterial({ color: HOLO_COLOR, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  ring2.rotation.x = Math.PI / 2;
  ring2.position.y = -0.5;
  scene.add(ring2);

  const pivot = new THREE.Group();
  scene.add(pivot);

  let current = null; // 当前轮毂 Object3D
  let raf = 0;
  let t = 0;
  let disposed = false;
  let paused = false;
  let loadToken = 0;

  function fitAndPlace(group) {
    // 居中 + 轴向对齐 Z（轮轴 = Z）
    const { diameter } = normalizeWheel(group);
    // 缩放到合适可视尺寸（盘面直径 ~0.9 单位）
    const target = 0.92;
    const s = diameter > 0.01 ? target / diameter : 1;
    group.scale.setScalar(s);
    group.updateMatrixWorld(true);
    // 初始给一个 3/4 展示角度
    group.rotation.set(0.32, 0.6, 0);
    pivot.add(group);
  }

  function applyHolo(group) {
    group.traverse((o) => {
      if (!o.isMesh) return;
      const base = new THREE.MeshStandardMaterial({
        color: 0x0c2c36,
        emissive: new THREE.Color(HOLO_EMISSIVE),
        emissiveIntensity: 0.5,
        metalness: 0.85,
        roughness: 0.28,
        transparent: true,
        opacity: 0.9,
      });
      o.material = base;
      // 叠加一层青色线框，制造"全息扫描"质感
      const wire = new THREE.Mesh(
        o.geometry,
        new THREE.MeshBasicMaterial({
          color: HOLO_COLOR,
          wireframe: true,
          transparent: true,
          opacity: 0.18,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      o.add(wire);
    });
  }

  async function setWheel(url) {
    if (!url) return;
    const my = ++loadToken;
    // 清掉旧的
    if (current) {
      pivot.remove(current);
      disposeObject(current);
      current = null;
    }
    try {
      const { group } = await loadGLB(url, { progress: false });
      if (disposed || my !== loadToken) {
        disposeObject(group);
        return;
      }
      applyHolo(group);
      fitAndPlace(group);
      current = group;
    } catch (e) {
      console.warn('[wheelHolo] 加载失败', e.message);
    }
  }

  function resize() {
    const w = container.clientWidth || 320;
    const h = container.clientHeight || 320;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function tick() {
    if (disposed || paused) return;
    t += 0.016;
    if (current) {
      current.rotation.y += 0.012; // 转盘自转
    }
    // 悬浮：整组上下轻微浮动 + 环状呼吸
    pivot.position.y = Math.sin(t * 1.1) * 0.035;
    const pulse = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin(t * 2.2));
    ringMat.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2));
    ring2.material.opacity = 0.18 + 0.18 * pulse;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  raf = requestAnimationFrame(tick);

  return {
    setWheel,
    pause() {
      paused = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    resume() {
      if (disposed || !paused) return;
      paused = false;
      raf = requestAnimationFrame(tick);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (current) disposeObject(current);
      disposeObject(pivot);
      ringGeo.dispose();
      ringMat.dispose();
      ring2.geometry.dispose();
      ring2.material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
