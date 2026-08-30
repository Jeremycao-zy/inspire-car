/**
 * _repro-tire.mjs — 回归保护：复现「_ensureTire 跑过之后再 _rebuildCorners」崩溃路径
 *
 * 背景（真实 Bug）：
 *   打开页面弹出 alert「整车模型载入失败：undefined is not an object
 *   (evaluating 'Object.keys(morphAttributes)')」。
 *
 *   根因在 src/tuning/wheelRig.js 的 _rebuildCorners()：
 *       const tireMesh = new THREE.Mesh(this._tireGeo || new THREE.BufferGeometry(), tireMat);
 *   _tireGeo 有两种形态：
 *     · 初始 = null                        → `null || new BufferGeometry()` 合法
 *     · _ensureTire() 之后 = { front, rear }（普通对象，非 BufferGeometry）
 *   于是第二次 _rebuildCorners() 就会把一个普通对象传给 Mesh 构造函数，
 *   构造函数内部立刻调用 updateMorphTargets()，读 geometry.morphAttributes 得到
 *   undefined，Object.keys(undefined) 直接抛 TypeError。
 *
 * 触发时序（与 src/main.js boot() 完全一致）：
 *   rig.useProceduralWheel()   → setWheelSource → _rebuildCorners()   // _tireGeo=null，OK
 *   app.apply()                → rig.update()   → _ensureTire()       // _tireGeo={front,rear}
 *   await app.loadCarFromUrl() → refitCar()     → rig.setCarSize()    // 💥 第二次重建
 *
 * 本脚本在 Node 里复刻这条路径（three 的场景图部分不依赖 WebGL，可直接跑）。
 *
 * 运行：node scripts/_repro-tire.mjs
 * 退出码：0 = 未复现（Bug 已修复）  1 = 复现了 Bug
 */

import * as THREE from 'three';
import { WheelRig } from '../src/tuning/wheelRig.js';

const AXLE = { et: 38, j: 8.5, camber: -1, rimInch: 19, tireWidthMm: 255, aspect: 35 };
const PARAMS = {
  front: { ...AXLE },
  rear: { ...AXLE },
  trackF: 0,
  trackR: 0,
  axleF: 0,
  axleR: 0,
  showTire: true,
};

let fail = 0;
const log = (s) => console.log(s);
const ok = (name, cond, detail = '') => {
  log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fail++;
};

/**
 * 复刻 main.js boot() 的调用顺序，返回是否抛错 + 抛错的 message。
 * @param {string} trigger 第二次重建的触发方式
 * @returns {{threw:boolean, message:string}}
 */
function runBootSequence(trigger) {
  const scene = new THREE.Scene();
  const rig = new WheelRig(scene);

  // ① 程序化轮毂：第一次 _rebuildCorners()，此时 _tireGeo === null
  rig.useProceduralWheel();
  if (rig._tireGeo !== null) {
    throw new Error(`前置条件不成立：初次重建后 _tireGeo 应为 null，实际 ${typeof rig._tireGeo}`);
  }
  const cornersAfterFirst = rig.corners.length;

  // ② app.apply() → rig.update() → _ensureTire()：_tireGeo 变成 {front, rear}
  rig.update(structuredClone(PARAMS));

  // ③ refitCar() → 第二次 _rebuildCorners()。修复前：这里抛 Object.keys(morphAttributes)
  if (trigger === 'setCarSize') {
    rig.setCarSize(new THREE.Vector3(4.6, 1.32, 1.92));
  } else if (trigger === 'setDetectedCorners') {
    rig.setDetectedCorners({
      frontX: 1.42,
      rearX: -1.45,
      halfTrackF: 0.83,
      halfTrackR: 0.85,
    });
  } else if (trigger === 'setWheelSource') {
    rig.setWheelSource(rig.wheelSource, { diameter: 0.48, width: 0.216 });
  } else {
    throw new Error(`未知触发方式：${trigger}`);
  }

  // ④ 重建后必须还能继续 update()，且四轮几何都合法
  rig.update(structuredClone(PARAMS));

  const bad = rig.corners.filter((c) => !c.tireMesh.geometry?.isBufferGeometry);
  if (bad.length) {
    throw new Error(`tireMesh 拿到非法几何：${bad.map((c) => c.id).join(',')}`);
  }

  rig.dispose();
  return cornersAfterFirst;
}

log('\n═══ 回归：_ensureTire 之后再 _rebuildCorners 不得崩溃 ═══\n');

for (const trigger of ['setCarSize', 'setDetectedCorners', 'setWheelSource']) {
  try {
    const n = runBootSequence(trigger);
    ok(`触发方式 ${trigger}：未抛错`, true, `初次重建 ${n} 个角，二次重建 + update() 均正常`);
  } catch (e) {
    // V8 报 "Cannot convert undefined or null to object"，
    // Safari/JSC 报 "undefined is not an object (evaluating 'Object.keys(morphAttributes)')"，
    // 是同一个 Object.keys(undefined)，两种文案都认。
    const stack = e.stack || '';
    const isMorphBug =
      /morphAttributes/.test(e.message) ||
      /updateMorphTargets/.test(stack) ||
      /Cannot convert undefined or null to object/.test(e.message);
    ok(
      `触发方式 ${trigger}：未抛错`,
      false,
      isMorphBug ? `复现了 Bug → ${e.message}` : `抛了非预期异常 → ${e.message}`
    );
  }
}

/* ---- 额外断言：_tireGeo 的两种形态都必须能被安全消费 ---- */
log('');
{
  const scene = new THREE.Scene();
  const rig = new WheelRig(scene);
  rig.useProceduralWheel();
  rig.update(structuredClone(PARAMS));

  ok('_ensureTire 后 _tireGeo 是 {front, rear} 容器（而非几何本身）',
    !!rig._tireGeo && !rig._tireGeo.isBufferGeometry &&
      !!rig._tireGeo.front?.isBufferGeometry && !!rig._tireGeo.rear?.isBufferGeometry,
    `front=${rig._tireGeo?.front?.type} rear=${rig._tireGeo?.rear?.type}`);

  ok('同轴左右共享同一份几何',
    rig.corners.find((c) => c.id === 'FL').tireMesh.geometry ===
      rig.corners.find((c) => c.id === 'FR').tireMesh.geometry);

  // 前后配不同 → 前后几何必须各一份
  const p = structuredClone(PARAMS);
  p.rear = { ...AXLE, rimInch: 20, tireWidthMm: 305, aspect: 30 };
  rig.update(p);
  ok('前后配不同尺寸 → 前后轴几何各自独立',
    rig._tireGeo.front !== rig._tireGeo.rear &&
      rig.corners.find((c) => c.id === 'FL').tireMesh.geometry === rig._tireGeo.front &&
      rig.corners.find((c) => c.id === 'RL').tireMesh.geometry === rig._tireGeo.rear);

  // showTire=false 时也不能出现非法几何
  const p2 = structuredClone(PARAMS);
  p2.showTire = false;
  rig.update(p2);
  ok('showTire=false 时四轮几何仍合法',
    rig.corners.every((c) => c.tireMesh.geometry?.isBufferGeometry) &&
      rig.corners.every((c) => c.tireMesh.visible === false));

  rig.dispose();
}

/* ---- 阶段二：完整复刻 main.js refitCar() 的时序（真实场景图 + 真实轮位探测） ---- */
log('');
{
  const scene = new THREE.Scene();
  const carOuter = new THREE.Group();
  const carInner = new THREE.Group();
  carOuter.add(carInner);
  scene.add(carOuter);
  // 车身 + 四个"焊死"的车轮，供 detectWheelCenters 探测
  carInner.add(new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.9, 1.9, 20, 6, 10), new THREE.MeshStandardMaterial()));
  for (const [x, z] of [[1.4, 0.9], [1.4, -0.9], [-1.4, 0.9], [-1.4, -0.9]]) {
    const wg = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 24);
    wg.rotateX(Math.PI / 2);
    const w = new THREE.Mesh(wg, new THREE.MeshStandardMaterial());
    w.position.set(x, 0.33, z);
    carInner.add(w);
  }
  carOuter.updateMatrixWorld(true);

  const rig = new WheelRig(scene);

  try {
    // ① useProceduralWheel()  → _rebuildCorners() #1
    rig.useProceduralWheel();
    // ② app.apply()           → update() → _ensureTire()，_tireGeo 变成 {front, rear}
    rig.update(structuredClone(PARAMS));
    // ③ refitCar()：setCarSize() → _rebuildCorners() #2（修复前在这里抛）
    rig.setCarSize(new THREE.Box3().setFromObject(carOuter).getSize(new THREE.Vector3()));
    // ④ refitCar()：autoDetectCorners() → setDetectedCorners() → _rebuildCorners() #3
    rig.autoDetectCorners(carInner);
    // ⑤ refitCar() 结尾的 apply()
    rig.update(structuredClone(PARAMS));

    ok('refitCar() 全时序（含 autoDetectCorners）未抛错', true,
      `corners=${rig.corners.length}，detected=${rig.detected ? '命中' : '回退经验公式'}`);
    ok('refitCar() 后四轮几何均合法且已装好轮胎',
      rig.corners.length === 4 &&
        rig.corners.every((c) => c.tireMesh.geometry?.isBufferGeometry) &&
        rig.corners.every((c) => c.tireMesh.geometry.attributes.position?.count > 0));
  } catch (e) {
    ok('refitCar() 全时序（含 autoDetectCorners）未抛错', false, e.message);
  }
  rig.dispose();
}

/* ---- 阶段三：轮胎材质必须随重建释放（tireMat 挂在 axle 上，走不到 rimRoot 的 traverse） ---- */
log('');
{
  const scene = new THREE.Scene();
  const rig = new WheelRig(scene);
  rig.useProceduralWheel();
  rig.update(structuredClone(PARAMS));

  // 只统计「轮胎材质」的创建与释放：用 uuid 集合把 tireMat 和轮毂材质区分开
  const proto = THREE.MeshStandardMaterial.prototype;
  const origDispose = proto.dispose;
  const tireUuids = new Set();
  let tireDisposed = 0;
  proto.dispose = function (...args) {
    if (tireUuids.has(this.uuid)) tireDisposed++;
    return origDispose.apply(this, args);
  };

  const createdUuids = new Set();
  let created = 0;

  try {
    for (const c of rig.corners) tireUuids.add(c.tireMat.uuid); // 初始 4 个

    // 连调 5 次 setCarSize，每次重建 4 个角 → 新建 20 个材质、释放 20 个
    for (let i = 0; i < 5; i++) {
      rig.setCarSize(new THREE.Vector3(4.6 + i * 0.1, 1.32, 1.92));
      rig.update(structuredClone(PARAMS));
      for (const c of rig.corners) {
        if (!tireUuids.has(c.tireMat.uuid)) {
          tireUuids.add(c.tireMat.uuid);
          createdUuids.add(c.tireMat.uuid);
          created++;
        }
      }
    }
    ok('连调 5 次 setCarSize → 新建 20 个 tireMat', created === 20, `created=${created}`);
    ok('连调 5 次 setCarSize → 释放 20 个 tireMat（修复前为 0）', tireDisposed === 20,
      `tireMat 释放 ${tireDisposed} 次`);
  } catch (e) {
    ok('材质释放统计', false, e.message);
  } finally {
    proto.dispose = origDispose;
  }

  rig.dispose();
}

/* ---- 阶段四：showTire=false 下反复重建不得卡在空占位件 ---- */
log('');
{
  const scene = new THREE.Scene();
  const rig = new WheelRig(scene);
  rig.useProceduralWheel();

  const p = structuredClone(PARAMS);
  p.showTire = false;

  let allOk = true;
  let detail = '';
  try {
    // 隐藏态下把三个重建入口各打 3 遍
    for (let i = 0; i < 3; i++) {
      rig.setCarSize(new THREE.Vector3(4.6 + i * 0.05, 1.32, 1.92));
      rig.update(structuredClone(p));
      rig.setWheelSource(rig.wheelSource, { diameter: 0.48, width: 0.216 });
      rig.update(structuredClone(p));
      rig.setDetectedCorners({ frontX: 1.42, rearX: -1.45, halfTrackF: 0.83, halfTrackR: 0.85 });
      rig.update(structuredClone(p));

      const legal = rig.corners.every((c) => c.tireMesh.geometry?.isBufferGeometry);
      const hidden = rig.corners.every((c) => c.tireMesh.visible === false);
      const notPlaceholder = rig.corners.every((c) => c.tireMesh.geometry !== rig._placeholderGeo);
      if (!legal || !hidden || !notPlaceholder) {
        allOk = false;
        detail = `第 ${i + 1} 轮：legal=${legal} hidden=${hidden} notPlaceholder=${notPlaceholder}`;
        break;
      }
    }
    ok('showTire=false 下反复重建（setCarSize/setWheelSource/setDetectedCorners 各 3 次）几何始终合法',
      allOk, detail || '3 轮全部通过：合法 + 不可见 + 非占位件');

    // ⚠️ 护栏分工说明（QA 独立复核时确认，切勿当冗余删掉）：
    //  · 上一条 notPlaceholder 才是「改动 3」的回归护栏，它反向验证会失败。
    //  · 下面这条测的是「切回 showTire=true 的自愈路径」，修复前后本来就通，
    //    反向验证时也仍然是 ✓ —— 所以它是对的好断言，但不构成改动 3 的护栏。
    //    留着它是为了防止有人误删 notPlaceholder 那条。
    // 切回 true 后四轮必须立即恢复真实轮胎（顶点数 > 0）
    rig.setCarSize(new THREE.Vector3(4.6, 1.32, 1.92)); // 再重建一次，制造"刚重置成占位件"的状态
    rig.update(structuredClone(p));
    rig.update(structuredClone(PARAMS)); // showTire=true
    const vtx = rig.corners.map((c) => c.tireMesh.geometry.attributes.position?.count ?? 0);
    ok('切回 showTire=true 后四轮立即恢复真实轮胎',
      rig.corners.length === 4 && vtx.every((n) => n > 0) &&
        rig.corners.every((c) => c.tireMesh.visible === true),
      `顶点数=[${vtx.join(', ')}]`);
  } catch (e) {
    ok('showTire=false 反复重建', false, e.message);
  }
  rig.dispose();
}

log(`\n═══ ${fail === 0 ? '通过：Bug 未复现' : `失败：复现 ${fail} 处`} ═══\n`);
process.exit(fail === 0 ? 0 : 1);
