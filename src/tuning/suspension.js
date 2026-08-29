/**
 * suspension.js — 悬挂物理纯函数（无几何依赖，可在 Node 独立单测）
 *
 * 设计约束（见 docs/increment-DESIGN-rim-suspension.md §3.1 / 任务 T01）：
 *   - 轮胎几何/车轮接地始终不变，仅「车身相对车轮」下移 Δ。
 *   - Δ>0 表示车身降低；Δ<0 表示车身升高。
 *   - 所有公式与阈值集中在本文件，是 UI 读数的唯一真值来源。
 *   - 本模块不得 import three，保证 `node scripts/_qa-suspension.mjs` 可纯函数运行。
 */

/* ----------------------------- 红线常量 ----------------------------- */

/** 离地间隙最低红线（mm）——澳洲 ADR 最低 100mm */
export const MIN_GROUND_CLEARANCE_MM = 100;
/** 离地间隙「黄区」下限（mm）：≥120 绿、100–120 黄、<100 红 */
export const GC_WARN_MM = 120;
/** 总高变化合规上限（mm）：|Δ| ≤ 50 为允许区，>50 视为危险 */
export const MAX_TOTAL_DELTA_MM = 50;
/** 总高变化「黄区」上限（mm）：|Δ| ≤ 30 绿、30–50 黄、>50 红 */
export const DELTA_OK_MM = 30;
/** 轮拱间隙安全下限（mm）：≥10 绿 */
export const FENDER_SAFE_MM = 10;
/** 轮拱间隙绝对下限（mm）：≥5 黄、<5 红；<0 必蹭胎 */
export const FENDER_MIN_MM = 5;

/** wheelExposureRatio 归一化区间（对应滑杆范围 [−10, +75] mm） */
export const WHEEL_EXPOSURE_MIN_MM = -10;
export const WHEEL_EXPOSURE_MAX_MM = 75;

/* ----------------------------- 纯函数 ----------------------------- */

/**
 * 轮胎外径（mm）。
 *   外径 = 轮辋直径 + 2 × 断面高
 *   断面高 = 胎宽 × 扁平比
 * 单位：轮辋英寸、胎宽 mm、扁平比 %，返回 mm。
 *
 * @param {number} rimDiameterInch 轮辋直径（英寸）
 * @param {number} tireWidthMm     胎宽（mm）
 * @param {number} aspect          扁平比（%）
 * @returns {number} 轮胎外径（mm）
 */
export function tireOuterDiameterMm(rimDiameterInch, tireWidthMm, aspect) {
  return rimDiameterInch * 25.4 + 2 * tireWidthMm * (aspect / 100);
}

/**
 * 计算悬挂读数（纯函数，单一真值）。
 *
 * @param {Object} args
 * @param {number} args.baseGroundClearanceMm 基准离地间隙（mm，未施加 Δ 前）
 * @param {number} args.baseFenderGapMm       基准轮拱间隙（mm，未施加 Δ 前）
 * @param {number} args.deltaMm               降低量 Δ（mm，>0 降低）
 * @returns {{ groundClearance:number, fenderGap:number, wheelExposureRatio:number }}
 *   groundClearance = baseGC − Δ
 *   fenderGap       = baseFG − Δ
 *   wheelExposureRatio 随 Δ 单调增（车身越低轮胎露出越多），用 (Δ−min)/(max−min) 归一化
 */
export function suspensionReadout({ baseGroundClearanceMm, baseFenderGapMm, deltaMm }) {
  const groundClearance = baseGroundClearanceMm - deltaMm;
  const fenderGap = baseFenderGapMm - deltaMm;
  const span = WHEEL_EXPOSURE_MAX_MM - WHEEL_EXPOSURE_MIN_MM;
  const raw = (deltaMm - WHEEL_EXPOSURE_MIN_MM) / span;
  const wheelExposureRatio = Math.min(1, Math.max(0, raw));
  return { groundClearance, fenderGap, wheelExposureRatio };
}

/* ----------------------------- 三色状态 ----------------------------- */

/**
 * 轮拱间隙状态（绿/黄/红）。
 * @param {number} gap 轮拱间隙（mm）
 * @returns {'good'|'warn'|'danger'}
 */
export function fenderStatus(gap) {
  if (gap >= FENDER_SAFE_MM) return 'good';
  if (gap >= FENDER_MIN_MM) return 'warn';
  return 'danger';
}

/**
 * 离地间隙状态（绿/黄/红）。
 * @param {number} gc 离地间隙（mm）
 * @returns {'good'|'warn'|'danger'}
 */
export function groundClearanceStatus(gc) {
  if (gc >= GC_WARN_MM) return 'good';
  if (gc >= MIN_GROUND_CLEARANCE_MM) return 'warn';
  return 'danger';
}

/**
 * 总高变化（降低量）状态（绿/黄/红），按 |Δ| 判定。
 * @param {number} deltaMm 降低量 Δ（mm）
 * @returns {'good'|'warn'|'danger'}
 */
export function deltaStatus(deltaMm) {
  const a = Math.abs(deltaMm);
  if (a <= DELTA_OK_MM) return 'good';
  if (a <= MAX_TOTAL_DELTA_MM) return 'warn';
  return 'danger';
}
