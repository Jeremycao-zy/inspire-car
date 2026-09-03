// 离线渲染参考图：用用户提供的 GLB（my-car.glb）从多个方位渲染标准机位图。
// 仅用做一次性的 guides 图生成，不参与线上运行时。
import { createRequire } from 'module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/Users/jeremysmac/.workbuddy/binaries/node/workspace/');
const { PNG } = require('pngjs');

// 让 GLTFLoader 在 Node 下不因贴图解码崩溃（贴图最终会被材质覆盖，不影响成图）
global.self = global;
class FakeImage {
  constructor() { this.width = 1; this.height = 1; this.naturalWidth = 1; this.naturalHeight = 1; this.complete = false; this._onload = null; }
  set src(v) { this._src = v; this.complete = true; if (this._onload) setImmediate(() => this._onload()); }
  get onload() { return this._onload; }
  set onload(f) { this._onload = f; }
}
global.Image = FakeImage;
global.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const SRC = process.argv[2] || '/Users/jeremysmac/WorkBuddy/2026-08-27-21-15-16/garage-demo/assets/my-car.glb';
const OUT = process.argv[3] || '/tmp/explore';
fs.mkdirSync(OUT, { recursive: true });

const W = 1024, H = 1024;
const gl = require('gl')(W, H, { preserveDrawingBuffer: true });
if (!gl) { console.error('GL context null'); process.exit(1); }

// 给 three 的 WebGLRenderer 提供最小 DOM 桩（仅用于创建 canvas domElement）
function makeCanvas() {
  return {
    width: W, height: H, style: {},
    addEventListener() {}, removeEventListener() {},
    getContext: () => gl,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
  };
}
global.document = {
  createElementNS: () => makeCanvas(),
  createElement: () => makeCanvas(),
  addEventListener() {}, removeEventListener() {},
};
global.window = global;
global.window.devicePixelRatio = 1;

const renderer = new THREE.WebGLRenderer({ context: gl, antialias: true });
renderer.setSize(W, H, false);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef0f3);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

// 灯光：均匀摄影棚布光，避免车尾过暗
scene.add(new THREE.HemisphereLight(0xffffff, 0xa0a6b0, 0.75));
const key = new THREE.DirectionalLight(0xffffff, 1.3);
key.position.set(4, 8, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5; key.shadow.camera.far = 40;
key.shadow.camera.left = -8; key.shadow.camera.right = 8;
key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
key.shadow.bias = -0.0004;
scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe0ff, 0.65);
fill.position.set(-5, 5, 3);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffe6d6, 0.45);
rim.position.set(-4, 5, -5);
scene.add(rim);

// 地面（接收阴影，淡色）
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.ShadowMaterial({ opacity: 0.28 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const buf = fs.readFileSync(SRC);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function loadGLB(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/Users/jeremysmac/WorkBuddy/2026-08-27-21-15-16/garage-vite/node_modules/three/examples/jsm/libs/draco/');
    loader.setDRACOLoader(draco);
    loader.parse(arrayBuffer, '', (gltf) => resolve(gltf), reject);
  });
}

const gltf = await loadGLB(ab);
const car = gltf.scene;

// 统一材质：银色车漆（贴图被覆盖，成图只体现形状与方位）。
// 可设 OVERRIDE=0 保留原始材质，测试 GLB 自带贴图/颜色。
const OVERRIDE_MATERIAL = process.env.OVERRIDE !== '0';
if (OVERRIDE_MATERIAL) {
  car.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.material = new THREE.MeshStandardMaterial({ color: 0xc7ccd4, metalness: 0.55, roughness: 0.38 });
    }
  });
} else {
  car.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}

// 归一：缩放使最大边≈4.6，居中 x/z，落于地面 y=0
const box = new THREE.Box3().setFromObject(car);
const size = new THREE.Vector3(); box.getSize(size);
const center = new THREE.Vector3(); box.getCenter(center);
const s = 4.6 / Math.max(size.x, size.y, size.z);
car.scale.setScalar(s);
car.updateMatrixWorld(true);
const box2 = new THREE.Box3().setFromObject(car);
const c2 = new THREE.Vector3(); box2.getCenter(c2);
car.position.x -= c2.x;
car.position.z -= c2.z;
car.position.y -= box2.min.y;
scene.add(car);

const box3 = new THREE.Box3().setFromObject(car);
const sz = new THREE.Vector3(); box3.getSize(sz);
const r = 0.5 * Math.max(sz.x, sz.y, sz.z);
const dist = (r / Math.sin((camera.fov * Math.PI / 180) / 2)) * 1.18;
const lookY = sz.y * 0.42;
const eyeY = sz.y * 0.5 + sz.y * 0.18;

// az: 绕 Y 轴方位角（度）。0=+X, 90=+Z, 180=-X, 270=-Z
function shoot(azDeg, file) {
  const a = (azDeg * Math.PI) / 180;
  const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  camera.position.set(dir.x * dist, eyeY, dir.z * dist);
  camera.lookAt(0, lookY, 0);
  camera.updateMatrixWorld(true);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4;
    const dst = y * W * 4;
    for (let x = 0; x < W * 4; x++) png.data[dst + x] = pixels[src + x];
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log('wrote', file);
}

// 最终 5 个机位：正面、侧前、正侧、正后、侧后
// 已核对模型朝向：+X 为车头，-X 为车尾，+Z 为车左侧，-Z 为车右侧
const shots = [
  [0, 'front.png'],      // 正面：车头正对镜头
  [-45, 'front-right.png'], // 侧前：车头 + 右侧车身
  [90, 'side.png'],      // 正侧：纯侧面，车头朝右
  [180, 'rear.png'],     // 正后：车尾正对镜头
  [225, 'rear-left.png'], // 侧后：车尾 + 左侧车身
];
for (const [az, f] of shots) shoot(az, path.join(OUT, f));

console.log('DONE', JSON.stringify({ size: [sz.x.toFixed(2), sz.y.toFixed(2), sz.z.toFixed(2)], dist: dist.toFixed(2) }));
