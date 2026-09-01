/**
 * wheelRig.js — 四轮装配 + ET/J/倾角实时变换（本项目核心）
 *
 * 层级设计（每个车轮一套，全部挂在同一个 root 下）：
 *
 *   mount        position = (轴X, 0, side × (半轮距 + ET位移 + 轮距微调))
 *    │            位置放在 y=0（接地印痕），倾角才是"绕接地点"旋转，而不是绕轮心
 *    └── camberPivot   rotation.x = 倾角(rad) × side
 *         │            绕 X 轴转 → 车轮绕自身接地点内倾/外倾
 *         └── axle     position.y = 轮胎外半径 R（改尺寸时车高随之变化）
 *              ├── rimRoot   scale = (直径系数, 直径系数, J宽度系数) ← 轮毂 GLB 克隆体
 *              └── tireMesh  程序化轮胎（共享几何，随胎宽/扁平比重建）
 *
 * 三个核心参数的物理含义：
 *   ET（偏距 mm）  → 沿轴向平移整个车轮。ET 越小越外凸：offset = (ET_REF - ET)/1000
 *   J （轮辋宽度 in）→ 沿轴向缩放轮毂模型：宽度 = J × 25.4mm，关于轮心对称生长
 *   倾角（度）      → 绕接地印痕旋转。负值 = 顶部内倾（内八），符合改装圈习惯
 *
 * 为什么 ET 放在 mount 而不是轮心：
 *   换 ET 时接地印痕也会外移，这是真实车辆的行为；
 *   若只挪轮心不动接地点，会出现"轮子飞出去、影子留在原地"的穿帮。
 */

import * as THREE from 'three';
import { buildTire, tireOuterRadius } from './tire.js';
import { buildProceduralRim, RIM_PRESETS } from './proceduralRim.js';
import { autoFitCorners, detectWheelCenters, fitmentReport } from './wheelFit.js';

/** 基准偏距：轮心正对轮拱中线时的 ET，用于换算"相对基准外移多少" */
export const ET_REF = 42;

/**
 * 原厂基准 ET / J —— **只用于 Δouter 与齐平度报告**，与 ET_REF 分工不同。
 *
 * 为什么不能直接改 ET_REF：scripts/_qa-edge-tire.mjs:419 把 ET_REF 的语义
 * 锁死为「几何零点」（`mount.position.z × side − baseHalfTrack === (ET_REF − ET)/1000`），
 * 改动它会直接打破 101/101。
 *
 * @see docs/increment-DESIGN-shell-chassis.md §5.3(1)
 */
export const OE_ET = { front: 30, rear: 31 };
export const OE_J = { front: 8.5, rear: 9.5 };

export class WheelRig {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'wheelRig';
    scene.add(this.root);

    /** @type {Array<any>} */
    this.corners = [];
    this.wheelSource = null; // 轮毂模板（GLB 或程序化），四个角 clone 它
    this.measured = { diameter: 0.48, width: 0.216 };
    this.carSize = new THREE.Vector3(4.6, 1.32, 1.92);
    this._tireGeo = null;
    /** 共享的空 BufferGeometry 占位件，见 _emptyTireGeo() */
    this._placeholderGeo = null;
    this._tireKeyF = '';
    this._tireKeyR = '';
    /** 每轮实时几何读数 {FL:{x,y,z,r,halfW,side}}，切除引擎与面板都读它 */
    this.live = {};
    this.params = null; // 记录当前参数，重建轮位时用它计算半轮距
    /** 来自底盘的轮位规格（cornerSpec）；字段名沿用 detected 以兼容既有测试 */
    this.detected = null;
    /**
     * 真车轴距/轮距（米）：{wheelbase, trackFront, trackRear, axleXFront?, axleXRear?}。
     * 设置后**优先于**按车身尺寸估算的轮位（autoFitCorners），
     * 因为估算值实测会偏 170mm 量级，而真车数据是准的。
     *
     * axleXFront / axleXRear 是前后轴的**绝对 x 坐标**（车长中心为 0、车头 +X），
     * 来自 BANG 拆解测到的车轮质心。给了就用它定位，没有才退回 ±wheelbase/2 ——
     * 真实车前后悬不等长，轴距中心 ≠ 车身包围盒中心，对称摆法会整体偏一个常量。
     */
    this.realGeometry = null;
    /**
     * 车身半宽（米）。**必须**由 main.js 从 ShellMeasure 注入。
     * 旧实现用 `carSize.z / 2`，会被车底中央伪影撑大 114mm，
     * 直接淹没 ±5mm 的 Flush 判定区间。未注入时退化到 carSize.z / 2。
     */
    this.bodyHalfWidth = 0;
  }

  /**
   * 注入底盘的轮位规格 —— 新架构的主路径。
   * @param {Object} spec Chassis.cornerSpec()
   */
  setCornerSpec(spec) {
    this.detected = spec;
    if (spec && Number.isFinite(spec.bodyHalfWidth)) this.bodyHalfWidth = spec.bodyHalfWidth;
    this._rebuildCorners();
  }

  /**
   * @deprecated 请用 setCornerSpec()。
   * 保留原因：scripts/_qa-edge-tire.mjs / _repro-tire.mjs 依赖这个名字，
   * 而它们断言的都是**相对量**（`mount.z × side − baseHalfTrack`），
   * 只要入参形状与 baseHalfTrack 字段不变，101/101 就不受影响。
   * @param {Object} detected
   */
  setDetectedCorners(detected) {
    this.setCornerSpec(detected);
  }

  /**
   * 注入真车轴距 / 轮距（米），让四个轮位落在**真实**位置上。
   *
   * 为什么要覆盖估算值：autoFitCorners 是按车身包围盒比例推的轮位，
   * 实测与模型真实车轮差 170mm 量级（演示车 |z| 0.63 vs 估算 0.795），
   * 会连带影响切除原车轮、齐边判定等一切依赖轮位的功能。
   *
   * 支持部分更新：只传 wheelbase 或只传轮距时，其余字段保持当前值；
   * 首次调用且字段不齐时，缺失字段用当前估算值补齐，避免只调一项时车轮不动。
   *
   * @param {{wheelbase?:number, trackFront?:number, trackRear?:number,
   *          axleXFront?:number, axleXRear?:number}} g
   */
  setRealGeometry(g) {
    if (!g) return false;
    const MIN = { wheelbase: 1.2, trackFront: 0.6, trackRear: 0.6 };
    const next = { ...(this.realGeometry || {}) };
    let changed = false;
    for (const key of ['wheelbase', 'trackFront', 'trackRear']) {
      const v = g[key];
      if (Number.isFinite(v) && v > MIN[key]) {
        next[key] = v;
        changed = true;
      }
    }
    /* 实测轴位置：只有"前轴确实在后轴前面"才采信，否则整对丢弃退回 ±wheelbase/2。
     * 不做对称 clamp —— 实测值被截断就退化成估算解，等于白测（chassis.js 同款处理）。 */
    for (const key of ['axleXFront', 'axleXRear']) {
      const v = g[key];
      if (Number.isFinite(v) && v !== next[key]) {
        next[key] = v;
        changed = true;
      }
    }
    if (
      Number.isFinite(next.axleXFront) &&
      Number.isFinite(next.axleXRear) &&
      next.axleXFront <= next.axleXRear
    ) {
      delete next.axleXFront;
      delete next.axleXRear;
    }
    if (!changed) return false;

    // 补齐缺失字段，让 _rebuildCorners 总能算出完整的四角
    const est = autoFitCorners({ carSize: this.carSize, rimWidth: ((this.params?.front?.j || 8.5) * 25.4) / 1000 });
    const estX = Math.abs(est.find((b) => b.id[0] === 'F')?.x || 0.85);
    const estZf = Math.abs(est.find((b) => b.id === 'FL')?.z || 0.7);
    const estZr = Math.abs(est.find((b) => b.id === 'RL')?.z || 0.7);
    if (!Number.isFinite(next.wheelbase) || next.wheelbase <= MIN.wheelbase) {
      next.wheelbase =
        Number.isFinite(next.axleXFront) && Number.isFinite(next.axleXRear)
          ? next.axleXFront - next.axleXRear
          : estX * 2;
    }
    if (!Number.isFinite(next.trackFront) || next.trackFront <= MIN.trackFront) next.trackFront = estZf * 2;
    if (!Number.isFinite(next.trackRear) || next.trackRear <= MIN.trackRear) next.trackRear = estZr * 2;

    this.realGeometry = next;
    this._rebuildCorners();
    return true;
  }

  /** 清掉真车几何约束，退回按车身尺寸估算 */
  clearRealGeometry() {
    this.realGeometry = null;
    this._rebuildCorners();
  }

  /**
   * 只清掉实测轴位置（保留轴距 / 轮距）。
   *
   * 为什么必须能单独清：axleXFront / axleXRear 是**绝对坐标**（米），换一辆车后
   * 留着上一辆车的值会把新轮毂直接摆飞；而轴距/轮距是标量，旧值只会略微不准。
   * setRealGeometry() 是"部分更新"语义（传 null 不改动），清不掉，所以单开一个口子。
   *
   * @returns {boolean} 是否真的清掉了东西
   */
  clearAxlePositions() {
    if (!this.realGeometry) return false;
    if (this.realGeometry.axleXFront === undefined && this.realGeometry.axleXRear === undefined) {
      return false;
    }
    delete this.realGeometry.axleXFront;
    delete this.realGeometry.axleXRear;
    this._rebuildCorners();
    return true;
  }

  /**
   * 注入车身半宽（来自 ShellMeasure 的分位数测量）。
   * @param {number} v 米
   */
  setBodyHalfWidth(v) {
    if (Number.isFinite(v) && v > 0) this.bodyHalfWidth = v;
  }

  /**
   * 【已废弃】直接从车模网格探测轮位。
   *
   * 废弃原因：车壳里根本没有车轮几何体，探测到的是车身下半侧板的质心
   * （实测给出轮径 1.45m > 车高 1.36m，几何上不可能）。
   *
   * 保留原因：scripts/_qa-edge-tire.mjs:499、_repro-tire.mjs:185、dryrun.mjs:127、
   *          render.mjs:91 仍在调用，删除会直接打破既有测试。
   * 产品代码（main.js）已改为 setCornerSpec(chassis.cornerSpec())。
   *
   * @deprecated
   * @param {THREE.Object3D} carGroup
   */
  autoDetectCorners(carGroup) {
    if (!carGroup) return;
    const detected = detectWheelCenters(carGroup, this.carSize);
    if (detected) this.setCornerSpec(detected);
  }

  /* ---------------- 输入 ---------------- */

  /** 设置整车尺寸（由 GLB 归一后得到），触发轮位重算 */
  setCarSize(size) {
    if (!size) return;
    this.carSize.copy(size);
    this._rebuildCorners();
  }

  /**
   * 设置轮毂模板。
   * @param {THREE.Object3D} group 已归一（居中 + 轴向为 Z）
   * @param {{diameter:number,width:number}} measured 归一量出的直径/宽度（米）
   */
  setWheelSource(group, measured) {
    this.wheelSource = group;
    if (measured && measured.diameter > 0 && measured.width > 0) {
      this.measured = { diameter: measured.diameter, width: measured.width };
    }
    this._rebuildCorners();
  }

  /** 没有轮毂模型时，退化为程序化轮毂，保证预览永远可用 */
  useProceduralWheel(style = 'default') {
    const preset = RIM_PRESETS.find((p) => p.style === style) || RIM_PRESETS[0];
    const g = buildProceduralRim({ diameter: 0.48, width: 0.216, spokes: preset.spokes, style: preset.style });
    this.setWheelSource(g, { diameter: 0.48, width: 0.216 });
  }

  /* ---------------- 装配 ---------------- */

  _rebuildCorners() {
    // 清空旧结构
    for (const c of this.corners) {
      c.mount.removeFromParent();
      c.rimRoot.traverse?.((o) => {
        if (o.isMesh && o.userData.__owned) {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        }
      });
      // tireMesh 挂在 axle 上而非 rimRoot 下（见下方的 axle.add(rimRoot, tireMesh)），
      // 走不到上面的 traverse 分支，所以轮胎材质必须在这里显式释放，
      // 否则每次重建（换车 / 转 90° / 改车长）都会漏 4 个 MeshStandardMaterial。
      // 轮胎几何不在这里 dispose —— 它由 _tireGeo.front/rear 统一持有，
      // 交给 _ensureTire() 覆盖时释放，避免重复 dispose。
      c.tireMat?.dispose?.();
    }
    this.corners = [];

    if (!this.wheelSource) return;

    // 定位轮位时，用"目标 J 宽度"而不是模型量出的宽度。
    // 原因是：图生 3D 出来的轮毂 GLB 可能包含轮胎，量出来的宽度会远大于轮辋宽度，
    // 导致轮子被错误地塞到车身深处。用目标 J 值定位，才是用户真正想看的轮辋位置。
    const targetRimWidth = ((this.params?.front?.j || 8.5) * 25.4) / 1000;
    let base = autoFitCorners({ carSize: this.carSize, rimWidth: targetRimWidth, detected: this.detected });

    /* 真车轴距/轮距优先：把估算出来的轮位强行校正到真实四角。
     * 约定：车长沿 X（前 +X），车宽沿 Z（左 +Z，side>0）。 */
    if (this.realGeometry) {
      const { wheelbase, trackFront, trackRear, axleXFront, axleXRear } = this.realGeometry;
      const hx = wheelbase / 2;
      const zf = trackFront / 2;
      const zr = trackRear / 2;
      // 实测轴位置优先：axleXFront/Rear 是前后轴的绝对 x，直接就是轮毂该落的位置。
      // 只有它们缺失时才退回 ±wheelbase/2（轴距中心 = 车身中心的对称假设）。
      const xF = Number.isFinite(axleXFront) ? axleXFront : hx;
      const xR = Number.isFinite(axleXRear) ? axleXRear : -hx;
      base = base.map((b) => {
        const isFront = b.id[0] === 'F';
        const x = isFront ? xF : xR;
        const half = isFront ? zf : zr;
        return { ...b, x, z: (b.side >= 0 ? 1 : -1) * half };
      });
    }

    for (const b of base) {
      const mount = new THREE.Group();
      mount.name = `mount-${b.id}`;

      const camberPivot = new THREE.Group();
      camberPivot.name = `camber-${b.id}`;

      const axle = new THREE.Group();
      axle.name = `axle-${b.id}`;

      const rimRoot = new THREE.Group();
      rimRoot.name = `rim-${b.id}`;
      const model = this.wheelSource.clone(true);
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          // 轮毂材质默认 FrontSide：图生 3D 的 wheel.glb 常是单面/法线不全的盘，
          // 从车内侧（背面）看会被背面剔除 → 表现成"一侧轮毂消失"。
          // 强制 DoubleSide，保证四个角的轮毂从任何角度都可见。
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m && m.side !== undefined) m.side = THREE.DoubleSide;
          }
        }
      });
      // 左轮镜像：轮毂模板以「正面（辐条/中心盘）朝 +Z」建模，4 个角 clone 默认同朝向，
      // 不处理会导致左右车轮同向——朝内一侧正好背对相机而看不到轮毂。
      // 左轮（side<0）绕轮心转 180°，让正面朝车身外侧，与右轮对称。
      if (b.side < 0) model.rotation.y = Math.PI;
      rimRoot.add(model);

      const tireMat = new THREE.MeshStandardMaterial({
        color: 0x15171b,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.35,
      });
      // 这里必须是一个真正的 BufferGeometry。
      // 旧写法是 `this._tireGeo || new THREE.BufferGeometry()`，但 _tireGeo 在
      // _ensureTire() 跑过之后会变成 {front, rear} 这个普通对象，第二次重建时
      // 就会被塞进 Mesh 构造函数 → updateMorphTargets() 读 geometry.morphAttributes
      // 得到 undefined → Object.keys(undefined) 直接抛。
      // 真实轮胎几何由随后的 _ensureTire() 赋给 c.tireMesh.geometry，这里只是占位。
      const tireMesh = new THREE.Mesh(this._emptyTireGeo(), tireMat);
      tireMesh.name = `tire-${b.id}`;
      tireMesh.castShadow = true;
      tireMesh.receiveShadow = true;
      tireMesh.userData.__owned = true;

      axle.add(rimRoot, tireMesh);
      camberPivot.add(axle);
      mount.add(camberPivot);
      this.root.add(mount);

      this.corners.push({
        id: b.id,
        label: b.label,
        side: b.side,
        baseX: b.x,
        baseHalfTrack: Math.abs(b.z),
        mount,
        camberPivot,
        axle,
        rimRoot,
        tireMesh,
        tireMat,
      });
    }

    // 强制下次重建轮胎几何
    this._tireKeyF = '';
    this._tireKeyR = '';
  }

  /**
   * 轮胎网格的占位几何（全角共享一份，空几何不占显存）。
   *
   * 为什么非它不可：THREE.Mesh 的构造函数内部会无条件调用 updateMorphTargets()，
   * 直接读 geometry.morphAttributes。任何不是 BufferGeometry 的值（null、普通对象）
   * 都会让 Object.keys(undefined) 抛 TypeError。
   *
   * @returns {THREE.BufferGeometry}
   */
  _emptyTireGeo() {
    if (!this._placeholderGeo) this._placeholderGeo = new THREE.BufferGeometry();
    return this._placeholderGeo;
  }

  /**
   * 轮胎几何按 (直径, 胎宽, 扁平比) 重建。
   * 前后轴参数可以不同，所以各建一份，同轴的左右两轮共享。
   * @param {Object} p
   * @returns {void}
   */
  _ensureTire(p) {
    const build = (a) => {
      const tire = buildTire({
        rimRadius: (a.rimInch * 25.4) / 2000,
        sectionWidth: a.tireWidthMm / 1000,
        aspect: a.aspect,
      });
      const g = tire.geometry;
      tire.geometry = null;
      return g;
    };
    const keyOf = (a) => `${a.rimInch}|${a.tireWidthMm}|${a.aspect}`;
    const kf = keyOf(p.front);
    const kr = keyOf(p.rear);

    if (!this._tireGeo) this._tireGeo = { front: null, rear: null };

    // 除 key 变化外，几何本身不合法（null / 被外部 dispose）时也要重建，
    // 保证任何一个出口上 _tireGeo.front / rear 都是可用的 BufferGeometry
    if (kf !== this._tireKeyF || !this._tireGeo.front?.isBufferGeometry) {
      this._tireGeo.front?.dispose?.();
      this._tireGeo.front = build(p.front);
      this._tireKeyF = kf;
    }
    if (kr !== this._tireKeyR || !this._tireGeo.rear?.isBufferGeometry) {
      this._tireGeo.rear?.dispose?.();
      this._tireGeo.rear = build(p.rear);
      this._tireKeyR = kr;
    }

    // 兜底：万一 build 出了非几何，退到占位件，绝不让 Mesh 拿到非法 geometry
    for (const c of this.corners) {
      const g = c.id[0] === 'F' ? this._tireGeo.front : this._tireGeo.rear;
      c.tireMesh.geometry = g?.isBufferGeometry ? g : this._emptyTireGeo();
    }
  }

  /* ---------------- 实时更新 ---------------- */

  /**
   * 应用全部参数。滑杆 input 事件直接调它，不做节流——
   * 这里只有矩阵赋值，成本远低于一帧的渲染开销。
   * @param {Object} p
   */
  update(p) {
    if (!this.corners.length) return;

    // 记录当前参数，重建轮位时用它定位（避免依赖可能包含轮胎的模型宽度）
    this.params = p;

    // 轮胎几何必须始终就绪：
    //   · showTire 时按参数实时重建；
    //   · 关掉显示时也要保证 front/rear 已经建好，避免任何调用方
    //     （切除引擎、面板、debug 入口）读到未初始化的几何；
    //   · 任何一轮仍挂着占位件时也要建——_rebuildCorners() 会把几何重置成占位件，
    //     若此时 showTire=false，光看 _tireGeo 是否合法会漏判，四轮就一直卡在
    //     0 顶点的空几何上（虽然不可见，但状态不干净）。
    const tireMissing =
      !this._tireGeo?.front?.isBufferGeometry ||
      !this._tireGeo?.rear?.isBufferGeometry ||
      this.corners.some((c) => c.tireMesh.geometry === this._placeholderGeo);
    if (p.showTire || tireMissing) {
      this._ensureTire(p);
    }

    /** 每个车轮自己的实时几何读数，供切除引擎与面板使用 */
    const live = {};

    for (const c of this.corners) {
      const isFront = c.id[0] === 'F';
      const a = isFront ? p.front : p.rear; // ← 前后轴各读各的参数

      const rimDiameter = (a.rimInch * 25.4) / 1000;
      const rimWidth = (a.j * 25.4) / 1000;
      const R = p.showTire
        ? tireOuterRadius(a.rimInch, a.tireWidthMm, a.aspect)
        : rimDiameter / 2;

      const sXY = rimDiameter / this.measured.diameter;
      const sZ = rimWidth / this.measured.width;

      const etOffset = (ET_REF - a.et) / 1000;
      const trackAdj = ((isFront ? p.trackF : p.trackR) || 0) / 1000;
      const xShift = ((isFront ? p.axleF : p.axleR) || 0) / 1000;
      const camberRad = THREE.MathUtils.degToRad(a.camber || 0);

      // ① ET：沿轴向整体外推 / 内收（接地点一起走）
      // 悬挂高度只移动车身，不移动车轮；车轮始终贴地（mount.y = 0）
      const z = c.side * (c.baseHalfTrack + etOffset + trackAdj);
      c.mount.position.set(c.baseX + xShift, 0, z);

      // ② 倾角：绕接地印痕旋转，负值顶部内倾
      c.camberPivot.rotation.x = camberRad * c.side;

      // ③ 尺寸：轮心抬到轮胎外半径
      c.axle.position.y = R;

      // ④ J 值：轮毂模型沿轴向缩放（关于轮心对称）
      c.rimRoot.scale.set(sXY, sXY, sZ);

      // 轮毂校准安全网（手动微调）：绕轮轴旋转 + 轮平面内/轴向小幅偏移。
      //   作用在 rimRoot（axle 的子节点）的本地变换上，与 mount.position / axle.position.y
      //   （悬挂 / ET / 轮距定位）互不干扰，是叠加关系。不改动克隆/镜像/applySuspension/_rebuildCorners。
      c.rimRoot.rotation.z = THREE.MathUtils.degToRad(p.rimSpinDeg || 0);
      c.rimRoot.position.set(
        (p.rimOffsetX || 0) / 1000,
        (p.rimOffsetY || 0) / 1000,
        (p.rimOffsetZ || 0) / 1000
      );

      c.tireMesh.visible = !!p.showTire;

      live[c.id] = {
        x: c.baseX + xShift,
        y: R,
        z,
        r: R,
        halfW: (p.showTire ? a.tireWidthMm / 1000 : rimWidth) / 2,
        side: c.side,
        rimWidth,
      };
    }

    this.root.updateMatrixWorld(true);
    this.live = live;
  }

  /** 当前设定下的齐平度读数（前后轴分别算，参数不同就会给出两个值） */
  report(p) {
    // ⚠️ 车身半宽必须来自 ShellMeasure 的分位数测量。
    //    旧代码用 carSize.z / 2，被车底伪影撑大 114mm，会淹没 ±5mm 的 Flush 区间。
    const bodyHalfWidth = this.bodyHalfWidth > 0 ? this.bodyHalfWidth : this.carSize.z / 2;

    const one = (cornerId, a, trackAdj, axleKey) => {
      const c = this.corners.find((x) => x.id === cornerId);
      const halfTrack = (c?.baseHalfTrack ?? bodyHalfWidth) + (trackAdj || 0) / 1000;
      const odMm = tireOuterRadius(a.rimInch, a.tireWidthMm, a.aspect) * 2000;
      return fitmentReport({
        halfTrack,
        et: a.et,
        j: a.j,
        oeEt: OE_ET[axleKey],
        oeJ: OE_J[axleKey],
        tireWidthMm: a.tireWidthMm,
        odMm,
        camberDeg: a.camber || 0,
        bodyHalfWidth,
        fenderOffset: (axleKey === 'front' ? p.fenderOffsetF : p.fenderOffsetR) || 0,
      });
    };

    const front = one('FL', p.front, p.trackF, 'front');
    const rear = one('RL', p.rear, p.trackR, 'rear');
    const same = Math.abs(front.flushMm - rear.flushMm) < 0.5 && front.verdict.text === rear.verdict.text;

    return { front, rear, same, flushMm: front.flushMm, verdict: front.verdict, bodyHalfWidth };
  }

  /** 供调试：返回四轮世界坐标 */
  worldPositions() {
    const out = {};
    for (const c of this.corners) {
      const v = new THREE.Vector3();
      c.axle.getWorldPosition(v);
      out[c.id] = { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
    }
    return out;
  }

  dispose() {
    this._tireGeo?.front?.dispose?.();
    this._tireGeo?.rear?.dispose?.();
    this._tireGeo = null;
    this._placeholderGeo?.dispose?.();
    this._placeholderGeo = null;
    for (const c of this.corners) {
      c.tireMat?.dispose?.();
      c.mount.removeFromParent();
    }
    this.root.removeFromParent();
    this.corners = [];
    // 清空实时读数，避免 main.js 的 updateCutout()（读 Object.keys(rig.live)）
    // 在 dispose 之后拿到上一辆车的过期轮位
    this.live = {};
  }
}
