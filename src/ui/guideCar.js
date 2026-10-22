/**
 * guideCar.js — 拍照引导里的动态 3D 车模
 *
 * 在取景框里放一台可自动旋转的车模（HERO_CAR_URL = /models/base-high-shaded.glb，
 * 即用户原本拍摄引导用的那台灰车），替代原来会被裁掉的静态 PNG 示例图。
 *
 * 行为：
 *  - 车模始终完整入镜（fitCamera 用外接球半径求距，任意 yaw 都不裁切）。
 *  - 每个拍摄角度对应一个车模朝向（正面 / 左前 45° / 正侧 / 正后 / 右后 45°），
 *    切换角度时车模平滑「自动旋转」到该朝向，作为取景参照。
 *  - 待机时轻微摆动，保持 3D 质感但不影响取景参照。
 *  - 用户拍完当前角度、切到下一角度时，车模自动转向下一个朝向。
 *
 * 坐标约定（同 glb.js / 全局）：+X = 车头、+Y = 上、+Z = 车身左侧。
 * 相机固定在 +Z 朝 -Z 看，故各角度 yaw（绕 Y，右手系）为：
 *   正面   : 车头(+X)朝相机       → -90°
 *   左前45 : 车头左前棱朝相机      → -45°
 *   正侧   : 车身左侧(+Z)朝相机    → 0°
 *   正后   : 车尾(-X)朝相机       → +90°
 *   右后45 : 车尾右后棱朝相机      → +135°
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadGLB, normalizeCar, boxOf, disposeObject } from '../core/glb.js';
import { HERO_CAR_URL } from '../core/presetCar.js';

const DEG = Math.PI / 180;

/** 拍摄角度 id → 车模朝向（弧度）。id 与 photoGuide.js 的 CAR_ANGLES 一一对应。 */
export const GUIDE_ANGLE_YAW = {
  front: -90 * DEG,
  frontLeft: -45 * DEG,
  side: 0,
  rear: 90 * DEG,
  rearRight: 135 * DEG,
};

/**
 * 在 container 内挂载一台动态 3D 车模。
 * @param {HTMLElement} container 取景框内的挂载点（绝对定位铺满）
 * @returns {object|null} 控制句柄，或容器不可用时返回 null（调用方回退静态图）
 */
export function createGuideCar(container) {
  if (!container) return null;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null; // 设备不支持 WebGL，交给调用方回退到静态示例图
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  Object.assign(renderer.domElement.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
  });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 100);

  // 离线环境贴图（RoomEnvironment）→ 给清漆车漆真实的棚拍反射，无需外部 HDR 文件。
  let pmrem = null;
  try {
    pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  } catch {
    /* 环境贴图失败不致命，灯光仍能照亮车模 */
  }

  // 三点布光（仿车库 hero）
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc2ccd6, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(5, 8, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
  fill.position.set(-6, 3, -4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(0, 4, -7);
  scene.add(rim);

  // 软接触阴影（让车「站」在取景框里）
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.ShadowMaterial({ opacity: 0.22 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const pivot = new THREE.Group();
  scene.add(pivot);

  let carGroup = null;
  let targetYaw = GUIDE_ANGLE_YAW.front;
  let currentYaw = targetYaw;
  let idle = 0;
  let running = false;
  let disposed = false;
  let carLoaded = false;
  let raf = 0;
  let lastT = 0;

  /** 按外接球半径求相机距离：任意 yaw 下整车都在画面内，永不被裁切 */
  function fitCamera() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    renderer.setSize(w, h, false);
    const r = carLoaded
      ? boxOf(pivot).getBoundingSphere(new THREE.Sphere()).radius
      : 2.5;
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const dist = (r / tanV) * 1.12; // 外接球 + 12% 余量
    const cy = carLoaded ? boxOf(pivot).getCenter(new THREE.Vector3()).y : 0.5;
    camera.position.set(0, cy * 0.62, dist);
    camera.lookAt(0, cy * 0.42, 0);
    camera.updateProjectionMatrix();
  }

  function loop(now) {
    if (!running || disposed) return;
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
    lastT = now;
    idle += dt;
    if (carGroup) {
      // 平滑趋近目标朝向（拍摄完成后自动旋转到下个角度）
      currentYaw += (targetYaw - currentYaw) * Math.min(1, dt * 3.5);
      // 轻微待机摆动 + 浮动，保持 3D 质感但偏离极小、不影响取景参照
      const sway = Math.sin(idle * 0.7) * 3 * DEG;
      pivot.rotation.y = currentYaw + sway;
      pivot.position.y = Math.sin(idle * 1.1) * 0.02;
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (running || disposed) return;
    running = true;
    lastT = 0;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // 加载车模：归一（长→X、高→Y、宽→Z）→ 缩放到 4.6m → 居中贴地
  loadGLB(HERO_CAR_URL, { progress: false })
    .then(({ group }) => {
      if (disposed) return;
      normalizeCar(group, { targetLength: 4.6, groundY: 0 });
      pivot.add(group);
      carGroup = group;
      const box = boxOf(pivot);
      ground.position.y = box.min.y; // 地面贴合车底
      carLoaded = true;
      fitCamera();
    })
    .catch((e) => console.warn('[guideCar] 车模加载失败，回退静态示例图', e));

  const ro = new ResizeObserver(() => fitCamera());
  ro.observe(container);
  fitCamera();
  // 首帧布局可能尚未稳定，下一帧再校准一次
  requestAnimationFrame(fitCamera);

  return {
    /** 旋转到指定角度（传入 CAR_ANGLES 的 id） */
    rotateTo(angleId) {
      if (angleId in GUIDE_ANGLE_YAW) targetYaw = GUIDE_ANGLE_YAW[angleId];
    },
    /** 显示车模并开始渲染（未拍摄时） */
    activate() {
      start();
    },
    /** 隐藏渲染（已拍摄、展示用户照片时省电） */
    deactivate() {
      stop();
    },
    resize: fitCamera,
    dispose() {
      disposed = true;
      stop();
      ro.disconnect();
      if (carGroup) disposeObject(carGroup);
      scene.environment?.dispose?.();
      pmrem?.dispose?.();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    },
  };
}
