/**
 * mascot3d.js — 首页「小灵」AI 人偶（真实 3D 模型，Three.js 程序化建模）
 *
 * 设计：白盔 + 深蓝脸屏（可开合护目镜）+ 青色发光眼 + 蓝身白「IC」胸标。
 *   · 待机：护目镜闭合、眼睛闭合成细缝（沉睡感），轻微浮动。
 *   · 唤醒/聆听/说话：护目镜掀开、眼睛睁大发光；说话时右臂小幅挥动。
 * 用程序化几何（球体/胶囊/平面 + 画布贴图）搭建，不依赖外部模型文件，
 * 单 WebGL 上下文、离屏即 dispose，避免 iOS Safari 多上下文崩溃。
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const DEG = Math.PI / 180;

/** 用 2D canvas 画文字贴图（透明底，仅文字），返回 THREE.CanvasTexture */
function textTexture(text, { w, h, color, font, weight = 700, align = 'center' }) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.font = `${weight} ${font}px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.fillText(text, align === 'center' ? w / 2 : w * 0.08, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createMascot3D(container) {
  if (!container) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null; // 无 WebGL → 调用方回退 2D 立绘
  }
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.setSize(container.clientWidth || 118, container.clientHeight || 140, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0.12, 3.15);
  camera.lookAt(0, 0.1, 0);

  // 环境反射（让白盔/蓝身有光泽）
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // 灯光
  const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa4ff, 0.85);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1.6, 2.4, 2.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7aa8ff, 0.9);
  rim.position.set(-2.0, 0.6, -1.6);
  scene.add(rim);
  const cyanFill = new THREE.PointLight(0x35e0ff, 0.5, 8);
  cyanFill.position.set(0, -0.2, 1.4);
  scene.add(cyanFill);

  const root = new THREE.Group();
  scene.add(root);

  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  // 材质
  const matHelmet = track(new THREE.MeshStandardMaterial({ color: 0xf6f8fb, roughness: 0.22, metalness: 0.12 }));
  const matBody = track(new THREE.MeshStandardMaterial({ color: 0x2f49ff, roughness: 0.38, metalness: 0.2 }));
  const matBodyDark = track(new THREE.MeshStandardMaterial({ color: 0x1d2bbf, roughness: 0.5, metalness: 0.15 }));
  const matVisor = track(new THREE.MeshStandardMaterial({ color: 0x0a1322, roughness: 0.08, metalness: 0.7, envMapIntensity: 1.4 }));
  const matFace = track(new THREE.MeshStandardMaterial({ color: 0x05080f, roughness: 0.6, metalness: 0.1 }));
  const matEye = track(new THREE.MeshStandardMaterial({ color: 0x35e0ff, emissive: 0x35e0ff, emissiveIntensity: 2.2, roughness: 0.4 }));
  const matAccent = track(new THREE.MeshStandardMaterial({ color: 0x10131c, roughness: 0.5 }));

  // ---- 头部 / 白盔 ----
  const head = new THREE.Group();
  head.position.y = 0.62;
  root.add(head);

  const helmet = track(new THREE.Mesh(new THREE.SphereGeometry(0.46, 40, 32), matHelmet));
  head.add(helmet);
  // 盔体下半段加厚（后脑壳）
  const shellBack = track(new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 24, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58), matHelmet));
  shellBack.position.y = -0.02;
  head.add(shellBack);

  // 盔标：INSPIRE CAR（白色盔体上的深灰贴图，略前凸）
  const brandTex = track(textTexture('INSPIRE CAR', { w: 512, h: 128, color: '#4a5266', font: 52 }));
  const brandMat = track(new THREE.MeshBasicMaterial({ map: brandTex, transparent: true, depthWrite: false }));
  const brand = track(new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.155), brandMat));
  brand.position.set(0, 0.26, 0.43);
  head.add(brand);

  // 顶部通风口（两道深灰槽）
  for (const dx of [-0.12, 0.12]) {
    const vent = track(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.05), matAccent));
    vent.position.set(dx, 0.45, 0.18);
    head.add(vent);
  }

  // 脸屏（暗色底板，眼睛贴其上）
  const face = track(new THREE.Mesh(new THREE.SphereGeometry(0.4, 32, 24, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), matFace));
  face.position.set(0, -0.04, 0.02);
  head.add(face);

  // 护目镜（可开合）：以顶部为铰链抬起
  const visorPivot = new THREE.Group();
  visorPivot.position.set(0, 0.2, 0.02);
  head.add(visorPivot);
  const visor = track(new THREE.Mesh(new THREE.SphereGeometry(0.43, 32, 24, -Math.PI * 0.62, Math.PI * 1.24, Math.PI * 0.42, Math.PI * 0.42), matVisor));
  visor.position.set(0, -0.2, 0.04);
  visorPivot.add(visor);
  // 护目镜上沿高光条
  const visorTrim = track(new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.022, 12, 32, Math.PI), matAccent));
  visorTrim.position.set(0, -0.2, 0.04);
  visorTrim.rotation.z = Math.PI;
  visorPivot.add(visorTrim);

  // 眼睛（青色发光球）
  function makeEye(x) {
    const e = track(new THREE.Mesh(new THREE.SphereGeometry(0.072, 20, 16), matEye));
    e.position.set(x, -0.02, 0.34);
    head.add(e);
    return e;
  }
  const eyeL = makeEye(-0.15);
  const eyeR = makeEye(0.15);

  // ---- 身体（蓝身 + IC 胸标）----
  const body = new THREE.Group();
  root.add(body);

  const torso = track(new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.28, 12, 24), matBody));
  torso.position.y = -0.02;
  body.add(torso);

  const belly = track(new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.12, 10, 20), matBodyDark));
  belly.position.set(0, -0.06, 0.06);
  body.add(belly);

  // IC 胸标
  const icTex = track(textTexture('IC', { w: 256, h: 256, color: '#ffffff', font: 150 }));
  const icMat = track(new THREE.MeshBasicMaterial({ map: icTex, transparent: true, depthWrite: false }));
  const ic = track(new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), icMat));
  ic.position.set(0, 0.0, 0.31);
  body.add(ic);

  // 手臂（胶囊，肩部为枢轴）
  function makeArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.33, 0.12, 0.02);
    const arm = track(new THREE.Mesh(new THREE.CapsuleGeometry(0.082, 0.24, 8, 16), matBody));
    arm.position.y = -0.18;
    pivot.add(arm);
    const hand = track(new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), matBody));
    hand.position.y = -0.34;
    pivot.add(hand);
    body.add(pivot);
    return pivot;
  }
  const armL = makeArm(-1);
  const armR = makeArm(1);
  armL.rotation.z = 0.18;
  armR.rotation.z = -0.18;

  // 腿
  function makeLeg(side) {
    const leg = track(new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.16, 8, 16), matBodyDark));
    leg.position.set(side * 0.14, -0.46, 0.04);
    body.add(leg);
    const foot = track(new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), matBody));
    foot.position.set(side * 0.14, -0.6, 0.08);
    body.add(foot);
  }
  makeLeg(-1); makeLeg(1);

  // ---- 状态与动画 ----
  let active = false;     // 护目镜开合 + 睁眼
  let speaking = false;   // 右臂挥动
  let visorT = 0;         // 当前护目镜开合插值 0=闭 1=开
  let eyeOpen = 0;        // 眼睛睁开插值
  let running = true;
  let raf = 0;
  const clock = new THREE.Clock();

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const t = clock.getElapsedTime();
    const dt = Math.min(clock.getDelta ? 0.016 : 0.016, 0.05);

    // 目标值
    const targetVisor = active ? 1 : 0;
    const targetEye = active ? 1 : 0;
    visorT += (targetVisor - visorT) * 0.12;
    eyeOpen += (targetEye - eyeOpen) * 0.14;

    // 护目镜掀开（绕顶部铰链上翻）
    visorPivot.rotation.x = -visorT * 1.15;
    visorPivot.position.y = 0.2 + visorT * 0.02;

    // 眼睛：睁大 + 发光
    const sc = 0.12 + eyeOpen * 0.88;
    eyeL.scale.set(1, sc, 1);
    eyeR.scale.set(1, sc, 1);
    const glow = 0.25 + eyeOpen * 2.4;
    matEye.emissiveIntensity = glow * (0.85 + Math.sin(t * 6) * 0.15 * eyeOpen);

    // 整体轻微浮动 + 待机摆动
    root.position.y = Math.sin(t * 1.4) * 0.03;
    root.rotation.y = Math.sin(t * 0.7) * 6 * DEG;

    // 右臂挥动（说话时）
    const wave = speaking ? (Math.sin(t * 9) * 0.5 + 0.5) : 0;
    armR.rotation.z = -0.18 - (speaking ? (0.5 + wave * 0.7) : 0);
    armR.rotation.x = speaking ? Math.sin(t * 9) * 0.12 : 0;

    renderer.render(scene, camera);
  }
  frame();

  // 尺寸自适应
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth || 118, h = container.clientHeight || 140;
    if (w < 2 || h < 2) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  return {
    setActive(v) { active = !!v; },
    setSpeaking(v) { speaking = !!v; if (v) active = true; },
    pause() { running = false; if (raf) cancelAnimationFrame(raf); },
    resume() { if (!running) { running = true; clock.getDelta(); frame(); } },
    dispose() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      disposables.forEach((o) => { o.dispose && o.dispose(); });
      if (scene.environment) scene.environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
