/**
 * tireSpecs.js — 轮胎/轮毂「数字底座」（精准适配层级的数据地基）
 *
 * 为什么单独建库，而不用 carSpecs.db.json 里的 rimInch/tireWidth/aspect：
 *   1. carSpecs.db.json 的轮胎三项是**整车标称值**（很多条目与真实原厂规格不符，
 *      例如 R230 库中写 18"255/45，真实是 19"255/35 前 + 19"285/30 后），
 *      却统一标了 source:'official-db' —— 标签说官方、数据却不可信，比没有数据更危险。
 *   2. 真实轮胎规格是**轴相关**的（前 255/35、后 285/30 完全不同），
 *      整车单值结构装不下。
 *   3. 精准适配需要的不只是规格数值，还要**可核查的来源**（手册/胎侧/DM），
 *      以及**推荐规格序列**（升级胎宽时能选哪些真实存在的型号，而不是拖出 237mm）。
 *
 * 数据分层（每条都带 confidence，UI 据此决定敢不敢给结论）：
 *   - 'oe'  原厂规格，来自车型手册 / 胎侧标记，可直接用于工程判断
 *   - 'db'  厂商公开规格（官网/规格表），可作参考
 *   - 'est' 估算值（按车身尺寸推的），仅供预览，**不参与间隙判定**
 *
 * 单位约定：胎宽/扁平比/ET/J/直径一律 mm 与 %（整数），只有 rimInch 是英寸。
 * 这与 suspension.js / wheelFit.js 现有约定一致，不要混用米。
 */

/* ----------------------------- 真实轮胎规格序列 ----------------------------- */

/**
 * 常见原厂/升级胎规格。key 用「胎宽/扁平比」表示，value 含真实外径与适用场景。
 * diameterMm 由公式算出（轮辋 + 2×胎宽×扁平比），此处只列序列与备注。
 * 选型时必须来自这个序列，不能用滑杆连续取值。
 */
export const TIRE_SIZE_SERIES = {
  // —— 豪华 GT / 轿跑 ——
  '255/35': { group: '豪华GT', note: 'R230 前轴原厂' },
  '285/30': { group: '豪华GT', note: 'R230 后轴原厂' },
  '255/40': { group: '豪华GT', note: '偏舒适' },
  '265/35': { group: '豪华GT', note: '常见升级' },
  '275/35': { group: '豪华GT', note: 'Supra 后轴原厂' },
  '285/35': { group: '豪华GT', note: '宽体后轴' },
  '245/35': { group: '运动轿跑', note: 'NSX / 911 前' },
  '245/30': { group: '运动轿跑', note: '低扁平-performance' },
  '305/30': { group: '运动轿跑', note: '911 后轴' },
  // —— 紧凑 / 家用 ——
  '225/45': { group: '紧凑轿跑', note: '3 系原厂' },
  '235/45': { group: '紧凑轿跑', note: 'Model 3 原厂' },
  '225/40': { group: '紧凑轿跑', note: 'Type R 前' },
  '235/40': { group: '紧凑轿跑', note: '常见升级' },
  '245/40': { group: '紧凑轿跑', note: 'Type R 后' },
  '205/45': { group: '入门', note: '经济规格' },
  '215/45': { group: '入门', note: '' },
  // —— SUV / 皮卡 ——
  '265/50': { group: 'SUV', note: '' },
  '275/45': { group: 'SUV', note: 'X5 原厂' },
  '255/60': { group: 'SUV', note: 'CR-V / RAV4' },
  '245/65': { group: 'SUV', note: 'RAV4' },
  '275/65': { group: '皮卡', note: 'F-150' },
  '265/70': { group: '皮卡', note: '' },
};

/**
 * 合法胎宽序列（mm）——真实轮胎的胎宽是离散的，不是连续可拖的。
 * 只允许在这些值里选，杜绝 237mm 这种不存在的规格。
 */
export const TIRE_WIDTHS_MM = [
  195, 205, 215, 225, 235, 245, 255, 265, 275, 285, 295, 305, 315, 325, 335, 345, 355,
];

/** 合法扁平比序列（%） */
export const TIRE_ASPECTS = [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75];

/** 合法轮辋直径序列（英寸） */
export const RIM_DIAMETERS_IN = [15, 16, 17, 18, 19, 20, 21, 22, 23];

/** 合法 J 值序列（轮辋宽度，单位 J；1J = 25.4mm） */
export const RIM_JS = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13];

/** 合法 ET 序列（mm） */
export const ET_VALUES_MM = [
  0, 5, 10, 12, 15, 16, 18, 20, 21, 22, 24, 25, 26, 27, 28, 30, 31, 32, 34, 35, 38, 40, 42, 43, 45, 48, 50, 55, 60,
];

/* ----------------------------- 车型底座 ----------------------------- */

/**
 * 精准适配支持的车型。每条含前后轴原厂规格 + 几何包络 + 数据可信度。
 *
 * ⚠️ confidence 语义（决定 UI 敢不敢下结论）：
 *   'oe'  轮胎与几何均为原厂手册值 → 可用于间隙判定
 *   'db'  轮胎有公开来源、几何为标称尺寸 → 可提示，判定结果须标注"参考"
 *   'est' 任一项为估算 → 只做预览，**不出判定结论**
 *
 * geometry 字段（mm）用于后续扫掠检测，命名与 chassis.js 现有约定对齐：
 *   halfTrackF/R     轮距半（轮中心到车身中线）
 *   archRadiusF/R    轮拱半径：**从轮心量到轮拱顶**（不是轮拱开口半径/2）。
 *                    必须满足「原厂 + 满压缩不蹭」：archR ≥ OD/2 + wheelRise + 30mm。
 *   wheelCenterGainF/R 轮心增益：满压缩时轮心相对车身的上移量 = suspTravel × gain。
 *                    双叉臂/多连杆前悬约 0.60–0.75。⚠️ 直接把 suspTravel 当轮心位移
 *                    会严重高估压缩量（会把原厂状态算成「蹭胎 −60mm」）——本项目踩过。
 *   archLipF/R       ⚠️ **估算值，不可作几何基准，保留仅供人工参考**（不要删字段，可能有别处引用）
 *                    轮拱外缘（翼子板）Z 向半宽。它是按车身尺寸**推算**的，不是实测。
 *                    实测反例：宝马 G20 的 archLipF=870，而该车原厂胎面外缘 =
 *                    halfTrackF 790.5 + 225/2 = 903 —— 翼子板竟比轮胎还靠内 33mm，
 *                    几何上不可能。**绝不可用作外侧间隙基准**，否则原厂即算出大幅干涉。
 *                    需要外侧几何时请用 clearance.js 的 options.fenderSkinAllowanceMm
 *                    （同样是标定值，但语义明确：原厂胎面外缘再往外多少）。
 *   suspTravelF/R    悬挂压缩行程（满压缩）
 *   reboundF/R       回弹行程
 *   steerDeg         前轴最大转向角
 *   brakeHalfF/R     刹车卡钳外缘到轮心的 Z 向距离
 *   shockHalfF/R     避震内摆到轮心的 Z 向距离
 */
export const TIRE_BASIS = {
  'mercedes-sl350-r230': {
    name: '奔驰 SL 350 (R230)',
    confidence: 'oe',
    source: 'R230 轮胎标识 / Mercedes-Benz 规格表',
    front: { rimInch: 19, j: 8.5, et: 30, tireWidthMm: 255, aspect: 35, camber: -1.0 },
    rear: { rimInch: 19, j: 9.5, et: 31, tireWidthMm: 285, aspect: 30, camber: -1.5 },
    geometry: {
      wheelbase: 2560, trackFront: 1535, trackRear: 1527,
      halfTrackF: 767.5, halfTrackR: 763.5,
      archRadiusF: 422, archRadiusR: 425,
      wheelCenterGainF: 0.68, wheelCenterGainR: 0.66,
      archLipF: 900, archLipR: 895,
      suspTravelF: 90, suspTravelR: 85,
      reboundF: 60, reboundR: 55,
      steerDeg: 33, brakeHalfF: 285, brakeHalfR: 275,
      shockHalfF: 300, shockHalfR: 300,
    },
  },
  'bmw-3series-g20-330i': {
    name: '宝马 3 系 330i (G20)',
    confidence: 'db',
    source: 'BMW 官方规格表（330i 原厂 225/45R18）',
    front: { rimInch: 18, j: 8, et: 26, tireWidthMm: 225, aspect: 45, camber: -1.0 },
    rear: { rimInch: 18, j: 8, et: 24, tireWidthMm: 225, aspect: 45, camber: -1.3 },
    geometry: {
      wheelbase: 2851, trackFront: 1581, trackRear: 1573,
      halfTrackF: 790.5, halfTrackR: 786.5,
      archRadiusF: 404, archRadiusR: 406,
      wheelCenterGainF: 0.70, wheelCenterGainR: 0.68,
      archLipF: 870, archLipR: 868,
      suspTravelF: 80, suspTravelR: 78,
      reboundF: 55, reboundR: 52,
      steerDeg: 36, brakeHalfF: 268, brakeHalfR: 265,
      shockHalfF: 290, shockHalfR: 292,
    },
  },
  'tesla-model3': {
    name: '特斯拉 Model 3',
    confidence: 'db',
    source: 'Tesla 官方规格（235/45R18）',
    front: { rimInch: 18, j: 8, et: 34, tireWidthMm: 235, aspect: 45, camber: -0.8 },
    rear: { rimInch: 18, j: 8, et: 31, tireWidthMm: 235, aspect: 45, camber: -1.2 },
    geometry: {
      wheelbase: 2875, trackFront: 1629, trackRear: 1620,
      halfTrackF: 814.5, halfTrackR: 810,
      archRadiusF: 404, archRadiusR: 406,
      wheelCenterGainF: 0.70, wheelCenterGainR: 0.68,
      archLipF: 900, archLipR: 898,
      suspTravelF: 75, suspTravelR: 72,
      reboundF: 50, reboundR: 48,
      steerDeg: 34, brakeHalfF: 270, brakeHalfR: 268,
      shockHalfF: 300, shockHalfR: 302,
    },
  },
  'honda-civic-typer-fk8': {
    name: '本田 思域 Type R (FK8)',
    confidence: 'db',
    source: 'Honda 官方规格（245/30R20 前 / 245/30R20 后）',
    front: { rimInch: 20, j: 9, et: 43, tireWidthMm: 245, aspect: 30, camber: -2.5 },
    rear: { rimInch: 20, j: 10, et: 40, tireWidthMm: 245, aspect: 30, camber: -2.0 },
    geometry: {
      wheelbase: 2730, trackFront: 1578, trackRear: 1570,
      halfTrackF: 789, halfTrackR: 785,
      archRadiusF: 411, archRadiusR: 413,
      wheelCenterGainF: 0.72, wheelCenterGainR: 0.70,
      archLipF: 885, archLipR: 882,
      suspTravelF: 70, suspTravelR: 68,
      reboundF: 50, reboundR: 48,
      steerDeg: 38, brakeHalfF: 275, brakeHalfR: 272,
      shockHalfF: 295, shockHalfR: 296,
    },
  },
  'toyota-gr-supra-a90': {
    name: '丰田 GR Supra (A90)',
    confidence: 'db',
    source: 'Toyota 官方规格（255/35R19 前 / 275/35R19 后）',
    front: { rimInch: 19, j: 8, et: 27, tireWidthMm: 255, aspect: 35, camber: -1.0 },
    rear: { rimInch: 19, j: 9, et: 22, tireWidthMm: 275, aspect: 35, camber: -1.5 },
    geometry: {
      wheelbase: 2470, trackFront: 1594, trackRear: 1589,
      halfTrackF: 797, halfTrackR: 794.5,
      archRadiusF: 416, archRadiusR: 419,
      wheelCenterGainF: 0.70, wheelCenterGainR: 0.68,
      archLipF: 875, archLipR: 878,
      suspTravelF: 80, suspTravelR: 80,
      reboundF: 55, reboundR: 55,
      steerDeg: 34, brakeHalfF: 272, brakeHalfR: 275,
      shockHalfF: 292, shockHalfR: 295,
    },
  },
  'porsche-911-carrera-992': {
    name: '保时捷 911 Carrera (992)',
    confidence: 'db',
    source: 'Porsche 官方规格（245/35R20 前 / 305/30R20 后）',
    front: { rimInch: 20, j: 9, et: 21, tireWidthMm: 245, aspect: 35, camber: -1.0 },
    rear: { rimInch: 20, j: 11.5, et: 16, tireWidthMm: 305, aspect: 30, camber: -1.8 },
    geometry: {
      wheelbase: 2450, trackFront: 1587, trackRear: 1580,
      halfTrackF: 793.5, halfTrackR: 790,
      archRadiusF: 419, archRadiusR: 424,
      wheelCenterGainF: 0.68, wheelCenterGainR: 0.66,
      archLipF: 880, archLipR: 892,
      suspTravelF: 85, suspTravelR: 88,
      reboundF: 58, reboundR: 60,
      steerDeg: 32, brakeHalfF: 280, brakeHalfR: 290,
      shockHalfF: 295, shockHalfR: 300,
    },
  },
};

/** 底座里已建档的车型 key 列表（未建档的只能做灵感预览） */
export const BASIS_CARS = Object.keys(TIRE_BASIS);

/* ----------------------------- 校验与查询 ----------------------------- */

/** 把任意值吸附到合法序列上（用于兼容旧的滑杆数据） */
export function snapTo(value, series) {
  let best = series[0];
  let bestD = Infinity;
  for (const s of series) {
    const d = Math.abs(s - value);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** 组合规格是否存在于真实序列中 */
export function isRealTireSize(tireWidthMm, aspect) {
  return !!TIRE_SIZE_SERIES[`${Math.round(tireWidthMm)}/${Math.round(aspect)}`];
}

/**
 * 把单轴的连续参数「合法化」：吸附到真实离散序列。
 * 这是从"滑杆"迁移到"真实规格"的强制关口——扫掠检测只接受合法化后的值。
 *
 * @param {{rimInch:number,j:number,et:number,tireWidthMm:number,aspect:number,camber?:number}} spec
 * @returns {spec} 合法化后的副本（camber 不吸附，它可以是任意调整值）
 */
export function legalizeSpec(spec) {
  const out = {
    rimInch: snapTo(spec.rimInch, RIM_DIAMETERS_IN),
    j: snapTo(spec.j, RIM_JS),
    et: snapTo(spec.et, ET_VALUES_MM),
    tireWidthMm: snapTo(spec.tireWidthMm, TIRE_WIDTHS_MM),
    aspect: snapTo(spec.aspect, TIRE_ASPECTS),
  };
  if (spec.camber != null) out.camber = spec.camber;
  return out;
}

/**
 * 取车型的原厂规格底座；未建档返回 null（调用方须降级为"仅预览"）。
 * @param {string|null} key 车型 key（如 mercedes-sl350-r230）
 */
export function getBasis(key) {
  if (!key) return null;
  return TIRE_BASIS[key] || null;
}

/** 该车型是否可做「精准适配」判定（confidence 必须达到 db 及以上） */
export function canJudge(key) {
  const b = getBasis(key);
  return !!b && (b.confidence === 'oe' || b.confidence === 'db');
}

/** 规格的展示标签，如 "255/35 R19" */
export function sizeLabel(spec) {
  return `${Math.round(spec.tireWidthMm)}/${Math.round(spec.aspect)} R${Math.round(spec.rimInch)}`;
}
