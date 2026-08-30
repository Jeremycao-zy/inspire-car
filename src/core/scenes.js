/**
 * scenes.js — 实景场景装饰（程序化几何 + Canvas 贴图）
 *
 * 目标：在不依赖任何外网 HDRI / 贴图的前提下，用 Three.js 内置图元 + 程序化
 * CanvasTexture 拼出尽量真实的「赛道」与「欧洲城市」环境，供
 *   · 主视口（core/viewer.js applyPreset 调用 buildDecor）
 *   · 灵感车库卡片动态预览（src/ui/planPreview.js 克隆模板）
 * 共用。
 *
 * 约定：
 *   · buildDecor(key, scene) 返回装饰 Group（含天空穹顶 / 地面 / 道具），调用方负责 add / dispose。
 *   · disposeDecor(group) 递归释放几何与材质（含贴图）。
 *   · makeSkyTexture(sky) 生成竖直渐变天空，供 scene.background 平铺。
 * 装饰几何只读、不随运行期变化 → 多实例可共享几何/贴图（planPreview 克隆模板）。
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/*                        Canvas 贴图工具                               */
/* ------------------------------------------------------------------ */

function canvasTexture(w, h, draw, { repeat = [1, 1], srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noise(ctx, w, h, n, alpha, palette) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const s = 1 + Math.random() * 2;
    const c = palette[(Math.random() * palette.length) | 0];
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
    ctx.fillRect(x, y, s, s);
  }
}

/* ---- 沥青（赛道） ---- */
export function asphaltTexture() {
  return canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#3a3d43';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 16000, 0.05, [
        [20, 22, 26],
        [70, 73, 80],
        [58, 60, 66],
      ]);
      // 几道淡淡的旧胎痕
      ctx.strokeStyle = 'rgba(15,15,18,0.06)';
      ctx.lineWidth = 10;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        const y = Math.random() * h;
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(w * 0.3, y + 30, w * 0.6, y - 30, w, y + 10);
        ctx.stroke();
      }
    },
    { repeat: [10, 10] }
  );
}

/* ---- 草地（赛道外围 / 城市绿地） ---- */
export function grassTexture() {
  return canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#4f7a3a';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 22000, 0.08, [
        [60, 96, 44],
        [86, 120, 60],
        [44, 70, 34],
      ]);
    },
    { repeat: [14, 14] }
  );
}

/* ---- 鹅卵石（欧洲广场） ---- */
export function cobbleTexture() {
  return canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#b9b2a6';
      ctx.fillRect(0, 0, w, h);
      const cols = 8;
      const rows = 8;
      const cw = w / cols;
      const ch = h / rows;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * (cw / 2);
        for (let c = -1; c <= cols; c++) {
          const x = c * cw + off + 2;
          const y = r * ch + 2;
          const base = 150 + ((Math.random() * 50) | 0);
          const g = base - 25 + ((Math.random() * 20) | 0);
          ctx.fillStyle = `rgb(${base},${g},${base - 35})`;
          roundRect(ctx, x, y, cw - 4, ch - 4, 8);
          ctx.fill();
          // 高光
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          roundRect(ctx, x + 3, y + 3, cw - 12, ch - 16, 6);
          ctx.fill();
        }
      }
    },
    { repeat: [6, 6] }
  );
}

/* ---- 建筑立面（欧洲风：暖色石材 + 窗格） ---- */
function facadeTexture(base, win) {
  return canvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 4000, 0.05, [[255, 255, 255], [0, 0, 0]]);
      // 窗格
      const cols = 4;
      const rows = 6;
      const mx = 22;
      const my = 18;
      const ww = (w - mx * 2) / cols;
      const wh = (h - my * 2) / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = mx + c * ww + ww * 0.18;
          const y = my + r * wh + wh * 0.18;
          const lit = Math.random() < 0.35;
          ctx.fillStyle = lit ? '#ffe9b0' : win;
          ctx.fillRect(x, y, ww * 0.64, wh * 0.64);
          // 窗框
          ctx.strokeStyle = 'rgba(40,30,20,0.5)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, ww * 0.64, wh * 0.64);
          // 窗棂
          ctx.beginPath();
          ctx.moveTo(x + ww * 0.32, y);
          ctx.lineTo(x + ww * 0.32, y + wh * 0.64);
          ctx.stroke();
        }
      }
    },
    { repeat: [1, 1] }
  );
}

/* ---- 棋盘格（起跑线） ---- */
export function checkerTexture() {
  return canvasTexture(
    64,
    64,
    (ctx, w, h) => {
      const n = 8;
      const s = w / n;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#0c0c0c' : '#f4f4f4';
          ctx.fillRect(x * s, y * s, s, s);
        }
    },
    { repeat: [1, 1] }
  );
}

/* ---- 红白路肩（kerb） ---- */
export function kerbTexture() {
  return canvasTexture(
    256,
    32,
    (ctx, w, h) => {
      const n = 16;
      const s = w / n;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i % 2 ? '#d11f2a' : '#f2f2f2';
        ctx.fillRect(i * s, 0, s, h);
      }
    },
    { repeat: [6, 1] }
  );
}

/* ---- 看台人群（grandstand） ---- */
export function crowdTexture() {
  return canvasTexture(
    256,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = '#23262d';
      ctx.fillRect(0, 0, w, h);
      const cols = ['#e7c14a', '#d8654f', '#5b8fd6', '#7fc08a', '#cfcfcf', '#e08fc0'];
      const step = 7;
      for (let y = 14; y < h - 8; y += step) {
        for (let x = 6; x < w - 6; x += step) {
          ctx.fillStyle = cols[(Math.random() * cols.length) | 0];
          ctx.fillRect(x + Math.random() * 2, y, 4, 5);
        }
      }
    },
    { repeat: [4, 1] }
  );
}

/* ---- 天空渐变（供背景平铺，竖直） ---- */
export function makeSkyTexture(sky) {
  const top = new THREE.Color(sky?.top ?? 0x9ec9ff);
  const horizon = new THREE.Color(sky?.horizon ?? 0xdcebfb);
  const bottom = new THREE.Color(sky?.bottom ?? 0xcfe0f0);
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, `#${top.getHexString()}`);
  g.addColorStop(0.55, `#${horizon.getHexString()}`);
  g.addColorStop(1, `#${bottom.getHexString()}`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---- 天空穹顶（3D 深度用，内壁渐变球） ---- */
function skyDome(sky, radius = 400) {
  const top = new THREE.Color(sky?.top ?? 0x9ec9ff);
  const horizon = new THREE.Color(sky?.horizon ?? 0xdcebfb);
  const bottom = new THREE.Color(sky?.bottom ?? 0xcfe0f0);
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, `#${top.getHexString()}`);
  g.addColorStop(0.5, `#${horizon.getHexString()}`);
  g.addColorStop(1, `#${bottom.getHexString()}`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  dome.name = 'sky-dome';
  return dome;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/*                          材质小工具                                 */
/* ------------------------------------------------------------------ */

function std(color, rough, metal = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

/* ------------------------------------------------------------------ */
/*                          赛道场景                                   */
/* ------------------------------------------------------------------ */

function buildRacetrack(scene) {
  const g = new THREE.Group();
  g.name = 'decor-racetrack';
  const sky = { top: 0x6ea8ef, horizon: 0xbfe0fb, bottom: 0xa9c8e6 };
  g.add(skyDome(sky));

  // 地面：整片沥青（车辆即停在赛道上）
  const asphalt = asphaltTexture();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(260, 260),
    std(0xffffff, 0.92, 0.02, { map: asphalt })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  g.add(ground);

  // 起跑/终点线（棋盘格），横跨赛道，车头朝 +X
  const checker = checkerTexture();
  const startLine = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 16),
    std(0xffffff, 0.7, 0, { map: checker })
  );
  startLine.rotation.x = -Math.PI / 2;
  startLine.position.set(-1.2, 0.02, 0);
  g.add(startLine);

  // 两侧白色边线 + 红白路肩
  const lineMat = std(0xf2f2f2, 0.6, 0, { emissive: 0x202020, emissiveIntensity: 0.12 });
  const kerb = kerbTexture();
  const kerbMat = std(0xffffff, 0.7, 0, { map: kerb });
  for (const z of [7, -7]) {
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(240, 0.22), lineMat);
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(0, 0.03, z);
    g.add(edge);
    const k = new THREE.Mesh(new THREE.BoxGeometry(240, 0.18, 0.7), kerbMat);
    k.position.set(0, 0.09, z + (z > 0 ? 0.55 : -0.55));
    k.receiveShadow = true;
    g.add(k);
  }

  // Tecpro 护栏（红/白挡板块），沿直道两侧
  const barrierMats = [std(0xd11f2a, 0.7), std(0xf2f2f2, 0.7)];
  const placeBarrier = (z) => {
    for (let x = -70; x <= 70; x += 3.6) {
      const m = barrierMats[((x / 3.6) | 0) % 2];
      const b = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.55), m);
      b.position.set(x, 0.45, z);
      b.castShadow = true;
      b.receiveShadow = true;
      g.add(b);
    }
  };
  placeBarrier(9.2);
  placeBarrier(-9.2);

  // 起跑门（拱）：两侧立柱 + 横梁 + 棋盘格顶
  const postMat = std(0xdedede, 0.6, 0.1);
  const beamMat = std(0xffffff, 0.7, 0, { map: checker });
  for (const z of [7.4, -7.4]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 5.2, 0.7), postMat);
    post.position.set(-2.4, 2.6, z);
    post.castShadow = true;
    g.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 16.2), beamMat);
  beam.position.set(-2.4, 5.2, 0);
  beam.castShadow = true;
  g.add(beam);

  // 看台（车后方 -Z）
  const standMat = std(0x9aa3ad, 0.85, 0.05);
  const crowd = crowdTexture();
  const frontMat = std(0xffffff, 0.9, 0, { map: crowd });
  const stand = new THREE.Mesh(new THREE.BoxGeometry(90, 7, 5), standMat);
  stand.position.set(0, 3.5, -22);
  stand.castShadow = true;
  stand.receiveShadow = true;
  g.add(stand);
  const standFront = new THREE.Mesh(new THREE.PlaneGeometry(90, 7), frontMat);
  standFront.position.set(0, 3.5, -19.45);
  g.add(standFront);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(92, 0.6, 7), std(0x394048, 0.8));
  roof.position.set(0, 7.2, -21);
  g.add(roof);

  // 轮胎墙（几处堆叠）
  const tireMat = std(0x111317, 0.95);
  const stack = (x, z) => {
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.5, 18), tireMat);
      t.position.set(x + (i % 2) * 0.1, 0.28 + i * 0.5, z);
      t.castShadow = true;
      g.add(t);
    }
  };
  stack(22, 7.6);
  stack(-22, -7.6);
  stack(-30, 7.6);

  return g;
}

/* ------------------------------------------------------------------ */
/*                        欧洲城市场景                                 */
/* ------------------------------------------------------------------ */

const EURO_FACADES = [
  ['#e9dcc3', '#3a4a63'],
  ['#d9b48f', '#36506b'],
  ['#cfd6cf', '#3a4658'],
  ['#e7c9b0', '#42506a'],
  ['#c9b79a', '#34465c'],
  ['#ead8c0', '#3d4c66'],
];
const EURO_ROOFS = [0xb1553f, 0x9c6b4a, 0x8c4a3a, 0xa86a4c, 0xb98a5e];

function europeanBuilding(x, z, w, h, d, rotY, facadeIdx) {
  const grp = new THREE.Group();
  grp.position.set(x, 0, z);
  grp.rotation.y = rotY;
  const [base, win] = EURO_FACADES[facadeIdx % EURO_FACADES.length];
  const tex = facadeTexture(base, win);
  tex.repeat.set(Math.max(1, Math.round(w / 3)), Math.max(1, Math.round(h / 3)));
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0xffffff, 0.85, 0.02, { map: tex }));
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  grp.add(body);
  // 坡屋顶（四坡：用 4 个斜面，简化为一个略小的盒子 + 顶盖）
  const roofColor = EURO_ROOFS[facadeIdx % EURO_ROOFS.length];
  const roofH = Math.max(1.4, h * 0.32);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(w, d) * 0.78, roofH, 4),
    std(roofColor, 0.8)
  );
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + roofH / 2 - 0.1;
  roof.castShadow = true;
  grp.add(roof);
  return grp;
}

function buildEuroCity(scene) {
  const g = new THREE.Group();
  g.name = 'decor-eurocity';
  const sky = { top: 0x8fb8ef, horizon: 0xd7e6f6, bottom: 0xc9d6e2 };
  g.add(skyDome(sky));

  // 草地底（远处）
  const grass = grassTexture();
  const grassGround = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    std(0xffffff, 1, 0, { map: grass })
  );
  grassGround.rotation.x = -Math.PI / 2;
  grassGround.position.y = -0.02;
  grassGround.receiveShadow = true;
  g.add(grassGround);

  // 广场（鹅卵石圆盘），车辆停在上面
  const cob = cobbleTexture();
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(20, 64),
    std(0xffffff, 0.95, 0.02, { map: cob })
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.receiveShadow = true;
  g.add(plaza);

  // 人行道环（浅灰）
  const walk = new THREE.Mesh(
    new THREE.RingGeometry(20, 23, 64),
    std(0xb8bcc2, 0.9)
  );
  walk.rotation.x = -Math.PI / 2;
  walk.position.y = 0.01;
  walk.receiveShadow = true;
  g.add(walk);

  // 周围建筑（一圈欧洲风建筑，留出入口缺口在 +X 方向）
  const R = 34;
  const N = 13;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    // 在 +X 正前方留一个缺口（视角方向），不挡车
    if (a > -0.5 && a < 0.5) continue;
    const x = Math.cos(a) * R;
    const z = Math.sin(a) * R;
    const h = 9 + ((i * 37) % 9);
    const w = 7 + ((i * 13) % 5);
    const d = 7 + ((i * 7) % 4);
    const b = europeanBuilding(x, z, w, h, d, -a + Math.PI / 2, i);
    g.add(b);
  }

  // 街道灯（发光顶 + 细杆），广场边缘
  const lampPole = std(0x2a2d33, 0.7, 0.3);
  const lampHead = new THREE.MeshStandardMaterial({
    color: 0xfff2c4,
    emissive: 0xffe7a0,
    emissiveIntensity: 1.4,
    roughness: 0.5,
  });
  const lampPos = [
    [16, 16],
    [-16, 16],
    [16, -16],
    [-16, -16],
  ];
  for (const [lx, lz] of lampPos) {
    const lamp = new THREE.Group();
    lamp.position.set(lx, 0, lz);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 5, 10), lampPole);
    pole.position.y = 2.5;
    pole.castShadow = true;
    lamp.add(pole);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), lampHead);
    head.position.y = 5;
    lamp.add(head);
    g.add(lamp);
  }

  // 行道树（车两侧），增添生活感
  const trunkMat = std(0x6b4a2f, 0.9);
  const leafMat = std(0x3f7d3a, 0.9);
  const tree = (x, z) => {
    const t = new THREE.Group();
    t.position.set(x, 0, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 2.4, 10), trunkMat);
    trunk.position.y = 1.2;
    trunk.castShadow = true;
    t.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 14), leafMat);
    crown.position.y = 3.4;
    crown.castShadow = true;
    t.add(crown);
    return t;
  };
  g.add(tree(11, 6));
  g.add(tree(-11, 6));
  g.add(tree(10, -7));
  g.add(tree(-12, -5));

  return g;
}

/* ------------------------------------------------------------------ */
/*                          对外接口                                   */
/* ------------------------------------------------------------------ */

/**
 * 按 key 生成装饰 Group（不含天空/地面？已含）。
 * @param {'racetrack'|'eurocity'} key
 * @param {THREE.Scene} scene 仅用于取用（此处未直接使用 scene，保留签名兼容）
 * @returns {THREE.Group|null}
 */
export function buildDecor(key, scene) {
  if (key === 'racetrack') return buildRacetrack(scene);
  if (key === 'eurocity') return buildEuroCity(scene);
  return null;
}

/** 递归释放装饰几何/材质/贴图 */
export function disposeDecor(root) {
  if (!root) return;
  root.traverse((o) => {
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
