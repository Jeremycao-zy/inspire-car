/**
 * wheelPlacement.js — 轮心外移量（ET / J / 胎宽 → 轮子实际内外位置）
 *
 * 解决一个真实存在的缺陷：
 *   `chassis.js` 的 `cornerSpec()` 把轮位写成 `z = ±halfTrack`，**完全不随 ET / J /
 *   胎宽变化**。也就是说用户在面板里把 ET 从 30 拖到 10，3D 里的轮子纹丝不动 ——
 *   「数据调节反应不出真实效果」。
 *
 * 真实世界的关系（单位 mm，本模块内部一律 mm，不与 chassis 的米制混用）：
 *   轮辋内缘（bead seat inner）相对轮心的位置 = −J/2 × 25.4
 *   轮胎断面中心相对轮辋内缘外移 = (胎宽 − 轮辋宽度) / 2
 *   → 胎面中心相对轮心外移 = (胎宽 − J×25.4) / 2
 *
 *   轮心 Z 位置 = 半轮距 + 胎面外偏移(相对原厂)
 *
 * 也就是说：**ET 减小 → 轮子外凸；胎宽相对轮辋越宽 → 胎面越靠外。**
 * 这正是改装圈里 "flush（齐平）" 的物理来源：把 ET 调小、胎宽配 J 值，
 * 让胎面外缘与翼子板齐平。
 *
 * ⚠️ 关键前提：halfTrack 测的是**原厂胎面中心**到车身中线的距离。
 *   改 ET 或换胎宽时，轮辋安装面不动（由悬架几何决定），变的是胎面相对轮辋的位置。
 *   所以必须以「原厂 ET / 原厂胎宽 / 原厂 J」为基准做差值，而不是绝对重算。
 *
 * 本模块不 import three，可被 Node 端直接单测。
 */

/* ----------------------------- 基础换算 ----------------------------- */

/** 轮辋宽度（J → mm） */
export function rimWidthMm(j) {
  return j * 25.4;
}

/**
 * 胎面中心相对轮心的外移量（mm，正 = 靠外）。
 * 胎面中心 = 轮辋内缘 + (胎宽 − 轮辋宽)/2 + 轮辋宽/2
 *          = 轮辋内缘 + 胎宽/2，而轮辋内缘 = −J/2×25.4
 *   → 外移 = 胎宽/2 − J×25.4/2
 */
export function treadCenterOffsetMm(tireWidthMm, j) {
  return tireWidthMm / 2 - rimWidthMm(j) / 2;
}

/** 轮胎外缘（最外点）相对轮心的外移（mm） */
export function tireOuterOffsetMm(tireWidthMm) {
  return tireWidthMm / 2;
}

/** 轮胎内缘（最内点）相对轮心的内移（mm，正数表示往内多少） */
export function tireInnerOffsetMm(tireWidthMm) {
  return tireWidthMm / 2;
}

/**
 * 相对原厂的轮心外移量（mm，正 = 往外凸）。
 *
 * 物理链条：
 *   1) ET 变化：轮辋安装面固定，ET 减小 δ → 整个轮子向外 δ。
 *      （ET = 轮辋安装面到轮心的距离；ET 小 = 轮心靠外 = 更凸）
 *   2) 胎宽/J 变化：胎面中心相对轮辋的位置变了，但**轮辋安装面没动**，
 *      所以轮心不动，变化的是胎面 —— 这一项不进轮心位移，只进胎面宽度。
 *
 * 因此轮心外移 **只由 ET 决定**；胎宽/J 影响的是胎面外缘位置与间隙，不影响轮心。
 * 这个区分很关键：把胎宽也算进轮心位移会让"换宽胎=轮子外凸"这种误解变成现实。
 *
 * @param {number} etMm 当前 ET（mm）
 * @param {number} oeEtMm 原厂 ET（mm）
 * @returns {number} 外移量（mm，正 = 外凸）
 */
export function hubOffsetMm(etMm, oeEtMm) {
  return oeEtMm - etMm;
}

/**
 * 胎面外缘相对车身中线的位置（mm，正 = 靠外）。
 * 用于算与翼子板/车身侧面的外侧间隙。
 *
 * @param {Object} o
 * @param {number} o.halfTrackMm   半轮距（轮心到车身中线）
 * @param {number} o.etMm          当前 ET
 * @param {number} o.oeEtMm        原厂 ET
 * @param {number} o.tireWidthMm   当前胎宽
 * @returns {number} 胎面外缘到中线的距离（mm）
 */
export function treadOuterZMm({ halfTrackMm, etMm, oeEtMm, tireWidthMm }) {
  const hubOff = hubOffsetMm(etMm, oeEtMm);
  return halfTrackMm + hubOff + tireOuterOffsetMm(tireWidthMm);
}

/**
 * 胎面外缘相对**参考外沿**的外凸量（mm，正 = 凸出参考线之外）。
 *
 * ⚠️ 参考线必须由调用方显式传入，且**必须自洽**——本函数不假设任何默认基准。
 * 曾经的坑：一开始用 `bodyHalfWidth`（车身最宽处，多半在后视镜/后翼子板处）
 * 当基准，算出原厂 −13.5mm；改用 tireBasis 的 `archLip` 后更离谱，原厂凸出 30~54mm。
 * 两者都错 —— `archLip` 本身是**估算值而非实测值**，不足以当几何基准。
 *
 * 正确用法：参考线应来自实测（车身实测或厂商数据）。若参考线不可信，
 * **就不要调用 flushMm**，只调用 hubOffsetMm / treadOuterZMm 这类纯几何量
 * （它们不依赖任何基准）。
 *
 * @param {Object} o
 * @param {number} o.halfTrackMm
 * @param {number} o.etMm
 * @param {number} o.oeEtMm
 * @param {number} o.tireWidthMm
 * @param {number} o.referenceZMm 参考外沿到车身中线的距离（mm，必须自洽可信）
 * @returns {number} 外凸量 mm（正 = 凸出）
 */
export function flushMm({ halfTrackMm, etMm, oeEtMm, tireWidthMm, referenceZMm }) {
  return treadOuterZMm({ halfTrackMm, etMm, oeEtMm, tireWidthMm }) - referenceZMm;
}

/* ----------------------------- 3D 轮位 ----------------------------- */

/**
 * 给 chassis.cornerSpec() 提供「带 ET 外移」的轮心 Z（单位米，内部换算）。
 *
 * 为什么要这一步：cornerSpec 现在写死 `z = ±halfTrack`，
 * 于是改 ET 在 3D 里毫无反应。真实轮辋安装面固定，改 ET 轮心必然内外移动。
 *
 * @param {Object} o
 * @param {number} o.halfTrackM  半轮距（米，来自 chassis）
 * @param {number} o.side        +1 左 / −1 右
 * @param {number} o.etMm        当前 ET
 * @param {number} o.oeEtMm      原厂 ET
 * @returns {number} 轮心 Z（米）
 */
export function wheelCenterZm({ halfTrackM, side, etMm, oeEtMm }) {
  const offM = hubOffsetMm(etMm, oeEtMm) / 1000;
  // side=+1（左）时 Z 为正（按项目约定 +Z 为车身左侧）
  return side * (halfTrackM + offM);
}

/**
 * 一次算出四角的轮心 Z（米），直接可喂给 WheelRig。
 * @param {Object} o
 * @param {number} o.halfTrackFM 前半轮距（米）
 * @param {number} o.halfTrackRM 后半轮距（米）
 * @param {Object} o.specs {front:{et}, rear:{et}}
 * @param {Object} o.oe    {front:{et}, rear:{et}} 原厂 ET
 * @returns {{FL:number,FR:number,RL:number,RR:number}}
 */
export function cornerWheelZ({ halfTrackFM, halfTrackRM, specs, oe }) {
  return {
    FL: wheelCenterZm({ halfTrackM: halfTrackFM, side: 1, etMm: specs.front.et, oeEtMm: oe.front.et }),
    FR: wheelCenterZm({ halfTrackM: halfTrackFM, side: -1, etMm: specs.front.et, oeEtMm: oe.front.et }),
    RL: wheelCenterZm({ halfTrackM: halfTrackRM, side: 1, etMm: specs.rear.et, oeEtMm: oe.rear.et }),
    RR: wheelCenterZm({ halfTrackM: halfTrackRM, side: -1, etMm: specs.rear.et, oeEtMm: oe.rear.et }),
  };
}
