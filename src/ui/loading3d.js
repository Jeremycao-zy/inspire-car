import * as THREE from 'three';
import './loading3d.css';

const CYAN = 0x3ee4ff;
const PINK = 0xff30d6;
const PURPLE = 0xa85cff;
const FRAME_INTERVAL_MS = 1000 / 30;
const ASSEMBLY_DURATION_SECONDS = 8.4;
const PARTICLE_COUNT = 42;
const SPARK_COUNT = 18;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function easeOutBack(value) {
  const t = clamp01(value);
  const c1 = 1.18;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function normalizeProgress(value) {
  if (!Number.isFinite(value)) return null;
  return clamp01(value > 1 ? value / 100 : value);
}

/**
 * Lightweight singleton Three.js loading scene.
 *
 * Only one loading WebGL context can exist at a time. Mounting into another host
 * first releases the old renderer, which keeps iOS Safari context and GPU memory
 * usage bounded while the main application swaps between loading surfaces.
 */
class Loading3DScene {
  constructor() {
    this.host = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.resizeObserver = null;
    this.parts = [];
    this.workers = [];
    this.grid = null;
    this.scanBeam = null;
    this.assemblyRing = null;
    this.particles = null;
    this.particlePositions = null;
    this.particleSeeds = null;
    this.sparks = null;
    this.sparkPositions = null;
    this.sparkSeeds = null;
    this.progress = null;
    this.progressElement = null;
    this.phaseElement = null;
    this.startedAt = 0;
    this.lastFrameAt = 0;
    this.reducedMotion = false;
    this.lookTarget = new THREE.Vector3(0, 0.85, 0);
    this._animate = this._animate.bind(this);
    this._handleVisibility = this._handleVisibility.bind(this);
  }

  /** Returns whether the singleton currently owns the supplied host. */
  isMountedIn(host) {
    return Boolean(host && this.host === host && this.renderer);
  }

  /**
   * Mounts the procedural assembly scene.
   * @param {HTMLElement} host
   * @param {{compact?: boolean, progress?: number|null}} options
   * @returns {boolean} false when WebGL is unavailable; the caller's spinner remains visible.
   */
  mount(host, { compact = false, progress = null } = {}) {
    if (!(host instanceof HTMLElement)) return false;
    if (this.isMountedIn(host)) {
      this.updateProgress(progress, host);
      return true;
    }

    this.dispose();
    this.host = host;
    this.progress = normalizeProgress(progress);
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    host.classList.toggle('loading3d-host--compact', Boolean(compact));
    host.classList.remove('is-fallback');
    host.innerHTML = `
      <div class="loading3d__viewport" aria-hidden="true"></div>
      <div class="loading3d__hud" aria-hidden="true">
        <span class="loading3d__phase">HOLOGRAPHIC ASSEMBLY</span>
        <span class="loading3d__percent">SYS // --</span>
      </div>
      <div class="loading3d__corners" aria-hidden="true"></div>
    `;

    try {
      const viewport = host.querySelector('.loading3d__viewport');
      this.progressElement = host.querySelector('.loading3d__percent');
      this.phaseElement = host.querySelector('.loading3d__phase');
      this.renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        depth: true,
        powerPreference: 'low-power',
        preserveDrawingBuffer: false,
      });
      this.renderer.setClearColor(0x050711, 1);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;
      this.renderer.domElement.className = 'loading3d__canvas';
      this.renderer.domElement.setAttribute('role', 'img');
      this.renderer.domElement.setAttribute(
        'aria-label',
        '科幻全息车间中，汽车零件与施工机器人正在组装车辆'
      );
      viewport.appendChild(this.renderer.domElement);

      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2(0x050711, 0.095);
      this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 40);
      this.camera.position.set(6.4, 3.8, 6.8);
      this.camera.lookAt(this.lookTarget);
      this._buildScene();
      this._resize();

      this.resizeObserver = new ResizeObserver(() => this._resize());
      this.resizeObserver.observe(host);
      document.addEventListener('visibilitychange', this._handleVisibility);
      this.startedAt = performance.now();
      this.lastFrameAt = 0;
      host.classList.add('is-active');
      host.parentElement?.classList.add('loading3d-active');
      this.updateProgress(progress, host);
      this.renderer.setAnimationLoop(this._animate);
      return true;
    } catch (error) {
      console.warn('[loading3d] WebGL unavailable, using spinner fallback:', error);
      this.dispose();
      host.classList.add('is-fallback');
      return false;
    }
  }

  /** Updates the optional real loading percentage without restarting the scene. */
  updateProgress(value, ownerHost = null) {
    if (ownerHost && ownerHost !== this.host) return;
    this.progress = normalizeProgress(value);
    this._updateHud(0);
  }

  /** Frees the loading renderer only when it belongs to ownerHost (if supplied). */
  dispose(ownerHost = null) {
    if (ownerHost && ownerHost !== this.host) return;

    const oldHost = this.host;
    document.removeEventListener('visibilitychange', this._handleVisibility);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
    }

    const geometries = new Set();
    const materials = new Set();
    this.scene?.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of objectMaterials) {
        if (material) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose?.();
    for (const material of materials) material.dispose?.();

    if (this.renderer) {
      this.renderer.renderLists?.dispose?.();
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
      const canvas = this.renderer.domElement;
      canvas.width = 1;
      canvas.height = 1;
      canvas.remove();
    }

    oldHost?.classList.remove('is-active');
    oldHost?.parentElement?.classList.remove('loading3d-active');
    if (oldHost) oldHost.innerHTML = '';

    this.host = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.parts = [];
    this.workers = [];
    this.grid = null;
    this.scanBeam = null;
    this.assemblyRing = null;
    this.particles = null;
    this.particlePositions = null;
    this.particleSeeds = null;
    this.sparks = null;
    this.sparkPositions = null;
    this.sparkSeeds = null;
    this.progressElement = null;
    this.phaseElement = null;
    this.progress = null;
  }

  _buildScene() {
    const ambient = new THREE.HemisphereLight(0x75eaff, 0x12051f, 1.2);
    this.scene.add(ambient);

    const cyanLight = new THREE.PointLight(CYAN, 7, 10, 2);
    cyanLight.position.set(3.2, 3.4, 3.1);
    this.scene.add(cyanLight);
    const pinkLight = new THREE.PointLight(PINK, 5, 9, 2);
    pinkLight.position.set(-3.4, 2.2, -2.4);
    this.scene.add(pinkLight);

    const grid = new THREE.GridHelper(11, 24, CYAN, 0x17315a);
    grid.position.y = -0.02;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.34;
      material.blending = THREE.AdditiveBlending;
    }
    this.grid = grid;
    this.scene.add(grid);

    const platformMaterial = new THREE.MeshBasicMaterial({
      color: 0x071221,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    });
    const platform = new THREE.Mesh(new THREE.CircleGeometry(2.75, 40), platformMaterial);
    platform.rotation.x = -Math.PI / 2;
    platform.position.y = 0.002;
    this.scene.add(platform);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: PURPLE,
      transparent: true,
      opacity: 0.58,
      blending: THREE.AdditiveBlending,
    });
    this.assemblyRing = new THREE.Mesh(new THREE.TorusGeometry(2.62, 0.018, 4, 64), ringMaterial);
    this.assemblyRing.rotation.x = Math.PI / 2;
    this.assemblyRing.position.y = 0.035;
    this.scene.add(this.assemblyRing);

    this._buildCar();
    this._buildWorkers();
    this._buildAtmosphere();
  }

  _buildCar() {
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const wheelGeometry = new THREE.TorusGeometry(0.38, 0.1, 8, 20);
    const solidCyan = new THREE.MeshStandardMaterial({
      color: 0x092735,
      emissive: CYAN,
      emissiveIntensity: 0.72,
      metalness: 0.85,
      roughness: 0.24,
      transparent: true,
      opacity: 0.82,
    });
    const solidPurple = new THREE.MeshStandardMaterial({
      color: 0x24113b,
      emissive: PURPLE,
      emissiveIntensity: 0.72,
      metalness: 0.82,
      roughness: 0.26,
      transparent: true,
      opacity: 0.8,
    });
    const solidPink = new THREE.MeshStandardMaterial({
      color: 0x310c2d,
      emissive: PINK,
      emissiveIntensity: 0.72,
      metalness: 0.82,
      roughness: 0.26,
      transparent: true,
      opacity: 0.82,
    });
    const wireCyan = new THREE.MeshBasicMaterial({
      color: CYAN,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
    });
    const wirePink = new THREE.MeshBasicMaterial({
      color: PINK,
      wireframe: true,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
    });

    const definitions = [
      { target: [0, 0.28, 0], scale: [3.5, 0.18, 1.42], from: [-4.2, 2.4, -2.8], delay: 0.0, material: solidPurple },
      { target: [0, 0.58, 0], scale: [3.15, 0.48, 1.35], from: [4.4, 2.1, 2.7], delay: 0.45, material: solidCyan },
      { target: [1.12, 0.9, 0], scale: [1.08, 0.22, 1.25], from: [3.9, 3.3, -2.8], delay: 0.85, material: solidPink },
      { target: [-0.3, 1.12, 0], scale: [1.42, 0.62, 1.12], from: [-3.5, 3.6, 2.6], delay: 1.15, material: solidPurple },
      { target: [-0.34, 1.47, 0], scale: [1.18, 0.12, 1.04], from: [0.2, 4.6, -3.4], delay: 1.4, material: solidCyan },
      { target: [-1.78, 0.62, 0], scale: [0.22, 0.32, 1.28], from: [-4.6, 1.0, 0.3], delay: 1.72, material: solidPink },
      { target: [1.78, 0.62, 0], scale: [0.22, 0.3, 1.28], from: [4.8, 1.4, -0.4], delay: 1.86, material: solidPink },
      { target: [1.72, 0.78, 0.43], scale: [0.08, 0.15, 0.28], from: [3.3, 3.8, 2.7], delay: 2.18, material: solidCyan },
      { target: [1.72, 0.78, -0.43], scale: [0.08, 0.15, 0.28], from: [3.1, 3.5, -2.8], delay: 2.26, material: solidCyan },
    ];

    for (let index = 0; index < definitions.length; index += 1) {
      const item = definitions[index];
      this._addCarPart({
        geometry: boxGeometry,
        material: item.material,
        wireMaterial: index % 3 === 2 ? wirePink : wireCyan,
        target: item.target,
        scale: item.scale,
        from: item.from,
        delay: item.delay,
        spin: [0.55 + index * 0.08, 1.2 + index * 0.13, 0.35 + index * 0.05],
      });
    }

    const wheelTargets = [
      [1.15, 0.48, 0.77],
      [1.15, 0.48, -0.77],
      [-1.15, 0.48, 0.77],
      [-1.15, 0.48, -0.77],
    ];
    const wheelSources = [
      [4.0, 2.8, 3.4],
      [4.1, 2.4, -3.3],
      [-4.1, 2.7, 3.1],
      [-4.0, 3.2, -3.4],
    ];
    for (let index = 0; index < wheelTargets.length; index += 1) {
      this._addCarPart({
        geometry: wheelGeometry,
        material: solidPink,
        wireMaterial: wirePink,
        target: wheelTargets[index],
        scale: [1, 1, 1],
        from: wheelSources[index],
        delay: 2.45 + index * 0.2,
        spin: [1.8, 2.4 + index * 0.2, 1.1],
      });
    }
  }

  _addCarPart({ geometry, material, wireMaterial, target, scale, from, delay, spin }) {
    const group = new THREE.Group();
    const solid = new THREE.Mesh(geometry, material);
    const wire = new THREE.Mesh(geometry, wireMaterial);
    wire.scale.set(1.025, 1.025, 1.025);
    group.add(solid, wire);
    group.scale.set(scale[0], scale[1], scale[2]);
    group.userData.target = new THREE.Vector3(target[0], target[1], target[2]);
    group.userData.source = new THREE.Vector3(from[0], from[1], from[2]);
    group.userData.delay = delay;
    group.userData.spin = new THREE.Vector3(spin[0], spin[1], spin[2]);
    group.position.copy(group.userData.source);
    this.parts.push(group);
    this.scene.add(group);
  }

  _buildWorkers() {
    const headGeometry = new THREE.SphereGeometry(0.13, 8, 6);
    const bodyGeometry = new THREE.BoxGeometry(0.32, 0.48, 0.22);
    const limbGeometry = new THREE.CapsuleGeometry(0.055, 0.27, 3, 6);
    const visorGeometry = new THREE.BoxGeometry(0.19, 0.055, 0.14);
    const workerMaterial = new THREE.MeshStandardMaterial({
      color: 0x102134,
      emissive: CYAN,
      emissiveIntensity: 0.75,
      metalness: 0.7,
      roughness: 0.28,
    });
    const accentMaterial = new THREE.MeshBasicMaterial({
      color: PINK,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
    });

    const workerDefinitions = [
      { position: [-2.25, 0.02, 1.55], rotationY: -0.72, phase: 0.0 },
      { position: [2.28, 0.02, -1.45], rotationY: 2.35, phase: 1.8 },
      { position: [2.34, 0.02, 1.3], rotationY: -2.25, phase: 3.5 },
    ];

    for (const definition of workerDefinitions) {
      const root = new THREE.Group();
      const body = new THREE.Mesh(bodyGeometry, workerMaterial);
      body.position.y = 0.7;
      root.add(body);

      const head = new THREE.Mesh(headGeometry, workerMaterial);
      head.position.y = 1.08;
      root.add(head);
      const visor = new THREE.Mesh(visorGeometry, accentMaterial);
      visor.position.set(0, 1.08, 0.105);
      root.add(visor);

      const leftArm = new THREE.Group();
      leftArm.position.set(-0.22, 0.9, 0);
      const leftLimb = new THREE.Mesh(limbGeometry, workerMaterial);
      leftLimb.position.y = -0.2;
      leftArm.add(leftLimb);
      root.add(leftArm);

      const rightArm = new THREE.Group();
      rightArm.position.set(0.22, 0.9, 0);
      const rightLimb = new THREE.Mesh(limbGeometry, workerMaterial);
      rightLimb.position.y = -0.2;
      rightArm.add(rightLimb);
      root.add(rightArm);

      const leftLeg = new THREE.Mesh(limbGeometry, workerMaterial);
      leftLeg.position.set(-0.1, 0.28, 0);
      const rightLeg = new THREE.Mesh(limbGeometry, workerMaterial);
      rightLeg.position.set(0.1, 0.28, 0);
      root.add(leftLeg, rightLeg);

      root.position.set(definition.position[0], definition.position[1], definition.position[2]);
      root.rotation.y = definition.rotationY;
      root.scale.setScalar(0.88);
      root.userData.baseX = definition.position[0];
      root.userData.baseY = definition.position[1];
      root.userData.phase = definition.phase;
      root.userData.leftArm = leftArm;
      root.userData.rightArm = rightArm;
      root.userData.leftLeg = leftLeg;
      root.userData.rightLeg = rightLeg;
      this.workers.push(root);
      this.scene.add(root);
    }
  }

  _buildAtmosphere() {
    const scanMaterial = new THREE.MeshBasicMaterial({
      color: CYAN,
      transparent: true,
      opacity: 0.11,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.scanBeam = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 3.0), scanMaterial);
    this.scanBeam.position.set(-2.1, 1.25, 0);
    this.scanBeam.rotation.y = Math.PI / 2;
    this.scene.add(this.scanBeam);

    const particleGeometry = new THREE.BufferGeometry();
    this.particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    this.particleSeeds = new Float32Array(PARTICLE_COUNT * 3);
    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      const offset = index * 3;
      const angle = (index / PARTICLE_COUNT) * Math.PI * 2 * 3.7;
      const radius = 1.1 + (index % 9) * 0.24;
      this.particleSeeds[offset] = Math.cos(angle) * radius;
      this.particleSeeds[offset + 1] = (index % 13) / 13;
      this.particleSeeds[offset + 2] = Math.sin(angle) * radius;
      this.particlePositions[offset] = this.particleSeeds[offset];
      this.particlePositions[offset + 1] = this.particleSeeds[offset + 1] * 3.1;
      this.particlePositions[offset + 2] = this.particleSeeds[offset + 2];
    }
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    const particleMaterial = new THREE.PointsMaterial({
      color: PURPLE,
      size: 0.045,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(particleGeometry, particleMaterial);
    this.scene.add(this.particles);

    const sparkGeometry = new THREE.BufferGeometry();
    this.sparkPositions = new Float32Array(SPARK_COUNT * 3);
    this.sparkSeeds = new Float32Array(SPARK_COUNT * 3);
    for (let index = 0; index < SPARK_COUNT; index += 1) {
      const offset = index * 3;
      this.sparkSeeds[offset] = ((index * 37) % 17) / 17;
      this.sparkSeeds[offset + 1] = ((index * 23) % 19) / 19;
      this.sparkSeeds[offset + 2] = ((index * 11) % 13) / 13;
    }
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(this.sparkPositions, 3));
    sparkGeometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    const sparkMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.075,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparks = new THREE.Points(sparkGeometry, sparkMaterial);
    this.sparks.position.set(1.77, 0.95, 0.68);
    this.scene.add(this.sparks);
  }

  _resize() {
    if (!this.host || !this.renderer || !this.camera) return;
    const bounds = this.host.getBoundingClientRect();
    const width = Math.max(220, Math.min(420, Math.round(bounds.width || 360)));
    const height = Math.max(150, Math.min(230, Math.round(bounds.height || 205)));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  _handleVisibility() {
    if (!this.renderer) return;
    if (document.hidden) {
      this.renderer.setAnimationLoop(null);
    } else {
      this.lastFrameAt = 0;
      this.renderer.setAnimationLoop(this._animate);
    }
  }

  _animate(now) {
    if (!this.renderer || !this.scene || !this.camera) return;
    if (now - this.lastFrameAt < FRAME_INTERVAL_MS) return;
    this.lastFrameAt = now;
    const seconds = Math.max(0, (now - this.startedAt) / 1000);
    const cycle = seconds % ASSEMBLY_DURATION_SECONDS;
    let assemblyClock = cycle;
    if (cycle >= 5.3 && cycle < 6.4) {
      assemblyClock = 5.3;
    } else if (cycle >= 6.4) {
      assemblyClock = Math.max(0, 5.3 - (cycle - 6.4) * 2.65);
    }
    const motionScale = this.reducedMotion ? 0.28 : 1;

    for (let index = 0; index < this.parts.length; index += 1) {
      const part = this.parts[index];
      const delay = part.userData.delay;
      const progress = easeOutBack((assemblyClock - delay) / 1.45);
      const source = part.userData.source;
      const target = part.userData.target;
      const spin = part.userData.spin;
      part.position.set(
        source.x + (target.x - source.x) * progress,
        source.y + (target.y - source.y) * progress + Math.sin(seconds * 3 + index) * 0.025 * (1 - clamp01(progress)),
        source.z + (target.z - source.z) * progress
      );
      const remaining = 1 - clamp01(progress);
      part.rotation.set(
        spin.x * remaining * motionScale,
        spin.y * remaining * motionScale,
        spin.z * remaining * motionScale
      );
      part.visible = progress > -0.08;
    }

    for (const worker of this.workers) {
      const phase = seconds * 2.2 + worker.userData.phase;
      worker.position.x = worker.userData.baseX + Math.sin(phase * 0.42) * 0.1 * motionScale;
      worker.position.y = worker.userData.baseY + Math.abs(Math.sin(phase)) * 0.035 * motionScale;
      worker.userData.leftArm.rotation.z = -0.35 + Math.sin(phase) * 0.55 * motionScale;
      worker.userData.rightArm.rotation.z = 0.35 - Math.sin(phase + 0.7) * 0.65 * motionScale;
      worker.userData.leftLeg.rotation.x = Math.sin(phase * 0.75) * 0.2 * motionScale;
      worker.userData.rightLeg.rotation.x = -Math.sin(phase * 0.75) * 0.2 * motionScale;
    }

    this.scanBeam.position.x = -2.1 + ((seconds * 0.72) % 4.2);
    this.scanBeam.material.opacity = 0.08 + Math.abs(Math.sin(seconds * 2.1)) * 0.08;
    this.assemblyRing.rotation.z = seconds * 0.14 * motionScale;
    this.assemblyRing.material.opacity = 0.4 + Math.sin(seconds * 2.4) * 0.16;
    const gridMaterials = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    for (const material of gridMaterials) {
      material.opacity = 0.28 + Math.sin(seconds * 1.4) * 0.06;
    }

    this._updateParticles(seconds);
    this._updateSparks(seconds);
    this._updateHud(seconds);

    const orbit = seconds * 0.12 * motionScale;
    this.camera.position.x = 6.35 + Math.sin(orbit) * 0.55;
    this.camera.position.z = 6.7 + Math.cos(orbit) * 0.45;
    this.camera.position.y = 3.65 + Math.sin(seconds * 0.23) * 0.12 * motionScale;
    this.camera.lookAt(this.lookTarget);
    this.renderer.render(this.scene, this.camera);
  }

  _updateParticles(seconds) {
    if (!this.particles || !this.particlePositions || !this.particleSeeds) return;
    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      const offset = index * 3;
      const seedY = this.particleSeeds[offset + 1];
      this.particlePositions[offset] = this.particleSeeds[offset] + Math.sin(seconds + index) * 0.025;
      this.particlePositions[offset + 1] = (seedY * 3.1 + seconds * (0.18 + (index % 5) * 0.025)) % 3.1;
      this.particlePositions[offset + 2] = this.particleSeeds[offset + 2];
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.rotation.y = seconds * 0.025;
  }

  _updateSparks(seconds) {
    if (!this.sparks || !this.sparkPositions || !this.sparkSeeds) return;
    const burst = Math.pow(Math.max(0, Math.sin(seconds * 5.2)), 5);
    this.sparks.material.opacity = 0.2 + burst * 0.8;
    for (let index = 0; index < SPARK_COUNT; index += 1) {
      const offset = index * 3;
      const life = (seconds * 2.2 + this.sparkSeeds[offset]) % 1;
      const angle = this.sparkSeeds[offset + 1] * Math.PI * 2;
      const distance = life * 0.38 * burst;
      this.sparkPositions[offset] = Math.cos(angle) * distance;
      this.sparkPositions[offset + 1] = (0.5 - life) * distance + this.sparkSeeds[offset + 2] * 0.08;
      this.sparkPositions[offset + 2] = Math.sin(angle) * distance;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
  }

  _updateHud(seconds) {
    if (!this.progressElement || !this.phaseElement) return;
    const simulated = Math.min(0.96, ((seconds || 0) % 6.2) / 6.2);
    const shown = this.progress ?? simulated;
    const percentage = Math.round(shown * 100);
    this.progressElement.textContent = `SYS // ${String(percentage).padStart(2, '0')}%`;
    if (shown < 0.3) this.phaseElement.textContent = 'CHASSIS MATRIX';
    else if (shown < 0.62) this.phaseElement.textContent = 'BODY SYNTHESIS';
    else if (shown < 0.9) this.phaseElement.textContent = 'WHEEL LINKAGE';
    else this.phaseElement.textContent = 'SYSTEM CALIBRATION';
  }
}

export const loading3D = new Loading3DScene();

export function mountLoading3D(host, options = {}) {
  return loading3D.mount(host, options);
}

export function updateLoading3DProgress(value, ownerHost = null) {
  loading3D.updateProgress(value, ownerHost);
}

export function disposeLoading3D(ownerHost = null) {
  loading3D.dispose(ownerHost);
}
