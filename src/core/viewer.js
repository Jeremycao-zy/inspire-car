/**
 * viewer.js — Three.js 渲染基座
 *
 * 负责：渲染器 / 相机 / 轨道控制 / 场景预设（环境光照 + 灯光组）/ 地面阴影 / 主循环。
 *
 * 场景与灯光全部来自 core/environments.js：
 *   · 程序化环境贴图（盒子房 + 发光板 → PMREM），不依赖外网 HDRI；
 *   · 每个预设 ≥5 盏灯，含专门的背光（rim，强度 ≥1.0）与 ≥2 盏投影灯，
 *     解决"背光面看不清"的问题。
 *
 * 灯光统一挂在 lightRig 这个 Group 下，切场景时整体重建，
 * 旧的 PMREM RenderTarget 会 dispose，不泄漏显存。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  DEFAULT_ENVIRONMENT,
  buildEnvScene,
  disposeEnvScene,
  getPreset,
  listPresets,
} from './environments.js';
import { buildDecor, disposeDecor, makeSkyTexture } from './scenes.js';

/**
 * @param {HTMLElement} container
 * @param {{preset?: string}} [opts]
 */
export function createViewer(container, opts = {}) {
  /* ---------- 渲染器 ---------- */
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // 返回灵感车库时要把当前 3D 视图截成方案封面，需保留绘制缓冲
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  /* ---------- 场景 ---------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1013);
  scene.fog = new THREE.Fog(0x0e1013, 18, 48);

  /* ---------- 相机 ---------- */
  const camera = new THREE.PerspectiveCamera(
    38,
    container.clientWidth / container.clientHeight,
    0.05,
    200
  );
  camera.position.set(5.2, 2.0, 6.4);

  /* ---------- 轨道控制 ---------- */
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, 0.75, 0);
  controls.minDistance = 2.2;
  controls.maxDistance = 26;
  controls.maxPolarAngle = Math.PI * 0.495; // 不允许钻到地面下
  controls.update();

  /* ---------- 灯光组（切场景时整体重建） ---------- */
  const lightRig = new THREE.Group();
  lightRig.name = 'lightRig';
  scene.add(lightRig);

  /** 实景装饰（赛道 / 欧洲城市等），切场景时整体重建 */
  let decorRoot = null;
  /** 天空渐变背景贴图缓存（按预设 id） */
  const skyCache = new Map();

  function getSkyTexture(preset) {
    if (!preset.sky) return null;
    if (!skyCache.has(preset.id)) skyCache.set(preset.id, makeSkyTexture(preset.sky));
    return skyCache.get(preset.id);
  }

  /** @type {Map<string, {spec:Object, light:THREE.Light}>} */
  const lightsById = new Map();

  /* ---------- 地面 / 阴影承接 / 网格（常驻，切场景时改属性） ---------- */
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(26, 96),
    new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.82, metalness: 0.05 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // 只接收阴影的透明层，让接触阴影更实
  const shadowCatcher = new THREE.Mesh(
    new THREE.CircleGeometry(14, 64),
    new THREE.ShadowMaterial({ opacity: 0.42 })
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = 0.002;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  /** @type {THREE.GridHelper|null} */
  let grid = null;

  function buildGrid(spec) {
    if (grid) {
      scene.remove(grid);
      grid.geometry?.dispose?.();
      const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const m of mats) m?.dispose?.();
      grid = null;
    }
    if (!spec || spec.enabled === false) return;
    grid = new THREE.GridHelper(spec.size ?? 40, spec.div ?? 40, spec.c1 ?? 0x2a2f38, spec.c2 ?? 0x1c2027);
    grid.position.y = spec.y ?? 0.004;
    grid.material.transparent = true;
    grid.material.opacity = spec.opacity ?? 0.5;
    scene.add(grid);
  }

  /* ---------- 环境贴图 ---------- */
  /** @type {THREE.WebGLRenderTarget|null} */
  let envRT = null;

  function disposeEnv() {
    if (envRT) {
      envRT.dispose();
      envRT = null;
    }
    scene.environment = null;
  }

  function buildEnv(preset) {
    disposeEnv();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = buildEnvScene(preset);
    try {
      envRT = pmrem.fromScene(envScene, preset.envSigma ?? 0.04);
      scene.environment = envRT.texture;
    } finally {
      pmrem.dispose();
      disposeEnvScene(envScene);
    }
  }

  /* ---------- 灯光构建 ---------- */

  /**
   * 按 spec 造一盏灯。
   * @param {Object} spec
   * @returns {THREE.Light}
   */
  function makeLight(spec) {
    const color = spec.color ?? 0xffffff;
    const intensity = spec.intensity;
    let light;

    switch (spec.type) {
      case 'ambient':
        light = new THREE.AmbientLight(color, intensity);
        break;

      case 'hemisphere':
        light = new THREE.HemisphereLight(spec.sky ?? 0xffffff, spec.ground ?? 0x222222, intensity);
        break;

      case 'point':
        light = new THREE.PointLight(color, intensity, spec.distance ?? 0, spec.decay ?? 2);
        light.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
        break;

      case 'spot':
        light = new THREE.SpotLight(
          color,
          intensity,
          spec.distance ?? 0,
          spec.angle ?? 0.6,
          spec.penumbra ?? 0.4,
          spec.decay ?? 2
        );
        light.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
        break;

      case 'directional':
      default:
        light = new THREE.DirectionalLight(color, intensity);
        light.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
        break;
    }

    light.name = `light-${spec.id}`;
    light.userData.lightId = spec.id;

    // 定向/聚光的朝向点必须挂进场景图，否则 matrixWorld 不会被自动更新
    if (light.target && spec.type !== 'point') {
      if (spec.target) light.target.position.set(spec.target[0], spec.target[1], spec.target[2]);
      else light.target.position.set(0, 0.6, 0); // 大致对准车身中部
      lightRig.add(light.target);
    }

    if (spec.castShadow) {
      const sh = spec.shadow || {};
      light.castShadow = true;
      light.shadow.mapSize.set(sh.mapSize ?? 2048, sh.mapSize ?? 2048);
      const area = sh.area ?? 8;
      const cam = light.shadow.camera;
      cam.left = -area;
      cam.right = area;
      cam.top = area;
      cam.bottom = -area;
      cam.near = sh.near ?? 1;
      cam.far = sh.far ?? 40;
      light.shadow.bias = sh.bias ?? -0.0005;
      light.shadow.normalBias = sh.normalBias ?? 0.02;
      cam.updateProjectionMatrix?.();
    }

    light.visible = spec.enabled !== false;
    return light;
  }

  function disposeLights() {
    for (const [, rec] of lightsById) {
      const l = rec.light;
      if (l.target && l.target.parent) l.target.parent.remove(l.target);
      if (l.shadow?.map) {
        l.shadow.map.dispose();
        l.shadow.map = null;
      }
      l.dispose?.();
      lightRig.remove(l);
    }
    lightsById.clear();
  }

  /* ---------- 场景预设 ---------- */

  let currentPresetId = null;

  /**
   * 应用一个场景预设（灯光 / 环境 / 背景 / 雾 / 地面 / 网格 / 曝光 全部重建）。
   * @param {string} presetId
   * @returns {string|null} 实际生效的预设 id
   */
  function applyPreset(presetId) {
    const preset = getPreset(presetId) || getPreset(DEFAULT_ENVIRONMENT);
    if (!preset) return null;

    currentPresetId = preset.id;

    // 1) 曝光
    renderer.toneMappingExposure = preset.exposure;

    // 2) 背景 / 雾
    const skyTex = preset.sky ? getSkyTexture(preset) : null;
    scene.background = skyTex || new THREE.Color(preset.background);
    if (preset.fog) scene.fog = new THREE.Fog(preset.fog.color, preset.fog.near, preset.fog.far);
    else scene.fog = null;

    // 2.5) 实景装饰（赛道 / 欧洲城市等）：先清旧，再按预设重建
    if (decorRoot) {
      scene.remove(decorRoot);
      disposeDecor(decorRoot);
      decorRoot = null;
    }
    if (preset.decor) {
      decorRoot = buildDecor(preset.decor, scene);
      if (decorRoot) scene.add(decorRoot);
    }

    // 3) 环境贴图（旧的 RT 在 buildEnv 里先 dispose）
    buildEnv(preset);

    // 4) 地面 / 阴影承接 / 网格
    ground.material.color.setHex(preset.ground.color);
    ground.material.roughness = preset.ground.roughness;
    ground.material.metalness = preset.ground.metalness;
    ground.material.needsUpdate = true;
    shadowCatcher.material.opacity = preset.shadowOpacity ?? 0.42;
    buildGrid(preset.grid);

    // 5) 灯光（先清后建，用户此前的强度/开关复写随场景一起重置）
    disposeLights();
    for (const spec of preset.lights) {
      const light = makeLight(spec);
      lightRig.add(light);
      lightsById.set(spec.id, { spec, light });
    }

    return preset.id;
  }

  /**
   * 设置某盏灯的强度。
   * @param {string} id
   * @param {number} v
   */
  function setLightIntensity(id, v) {
    const rec = lightsById.get(id);
    if (!rec) return;
    rec.light.intensity = v;
  }

  /**
   * 开关某盏灯。
   * @param {string} id
   * @param {boolean} on
   */
  function setLightEnabled(id, on) {
    const rec = lightsById.get(id);
    if (!rec) return;
    rec.light.visible = !!on;
  }

  /**
   * 设置曝光（只改 toneMappingExposure，不触发场景重建）。
   * @param {number} v
   */
  function setExposure(v) {
    renderer.toneMappingExposure = v;
  }

  function getExposure() {
    return renderer.toneMappingExposure;
  }

  function getPresetId() {
    return currentPresetId;
  }

  /** 供面板渲染灯光列表 */
  function getLights() {
    return [...lightsById.values()].map(({ spec, light }) => ({
      id: spec.id,
      label: spec.label,
      role: spec.role || '',
      type: spec.type,
      intensity: light.intensity,
      min: spec.min ?? 0,
      max: spec.max ?? 6,
      step: spec.step ?? 0.05,
      enabled: light.visible,
      castShadow: !!light.castShadow,
    }));
  }

  /** 重置为当前预设的出厂灯光（用户调乱了用） */
  function resetLights() {
    if (currentPresetId) applyPreset(currentPresetId);
  }

  /* ---------- 尺寸自适应 ---------- */
  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  /* ---------- 主循环 ---------- */
  const updaters = new Set();
  renderer.setAnimationLoop((t) => {
    controls.update();
    for (const fn of updaters) fn(t);
    renderer.render(scene, camera);
  });

  /** 把相机对准某个包围盒 */
  function frameBox(box, pad = 1.35) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360) * pad;
    const dir = new THREE.Vector3(0.72, 0.34, 0.9).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.target.copy(center);
    controls.minDistance = maxDim * 0.35;
    controls.maxDistance = maxDim * 6;
    controls.update();
  }

  // 启动即套用默认场景
  applyPreset(opts.preset || DEFAULT_ENVIRONMENT);

  return {
    renderer,
    scene,
    camera,
    controls,
    lightRig,
    frameBox,
    onUpdate(fn) {
      updaters.add(fn);
      return () => updaters.delete(fn);
    },

    /* ---- 场景 / 灯光 API ---- */
    applyPreset,
    setLightIntensity,
    setLightEnabled,
    setExposure,
    getExposure,
    getPresetId,
    getLights,
    resetLights,
    listPresets,

    dispose() {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      disposeLights();
      scene.remove(lightRig);
      buildGrid(null);
      disposeEnv();
      if (decorRoot) {
        scene.remove(decorRoot);
        disposeDecor(decorRoot);
        decorRoot = null;
      }
      for (const t of skyCache.values()) t.dispose();
      skyCache.clear();
      ground.geometry.dispose();
      ground.material.dispose();
      shadowCatcher.geometry.dispose();
      shadowCatcher.material.dispose();
      renderer.dispose();
    },
  };
}
