/**
 * partClassify.js — 按几何特征判断一个部件是不是车轮
 *
 * 为什么单独立文件：这是纯函数（只吃尺寸数组 + 车长），不依赖 THREE / DOM，
 * 所以能在 Node 里直接用**真实量测数据**跑单元测试，而不用起浏览器。
 *
 * 判定依据（三条同时满足才算车轮，缺一不可）：
 *   1. 圆度高   roundness = d2/d1 → 1       横截面接近正圆（车身/玻璃是长扁的）
 *   2. 盘状     厚径比 thin = d3/直径 0.15~0.65
 *                 太薄(→0)是刹车盘/贴片，太厚(→1)是车身块
 *   3. 尺度对   相对车长 rel = 直径/车长 0.1~0.45
 *                 排除过小碎片与过大车身
 *
 * 阈值来源：用 scripts/_probe-connected-parts.mjs 对真实车模量出来的数据反推——
 *   - 演示车 4 个车轮：0.175×0.176×0.066，车长 1.184 → 圆度 0.99 / 厚径比 0.38 / rel 0.15
 *   - 车身：1.184×0.311×0.538        → 圆度 0.45（被排除）
 *   - 刹车盘碎片：0.057×0.074×0.003 → 厚径比 0.05（被排除）
 *
 * ⚠️ maxThin 为什么从 0.55 放宽到 0.65（2026-08-31 修正）：
 *   0.55 是用上面那批**窄胎**样本反推的（胎宽 66mm / 直径 176mm → 0.38）。
 *   实测撞上反例：bang-car-0-0957d7.glb（宽胎车，归一后车长 4.6m）的四只车轮
 *     0.359×0.623×0.641 → 圆度 0.97 / 厚径比 0.57
 *     0.353×0.637×0.630 → 圆度 0.99 / 厚径比 0.56
 *   圆度判据完美满足，却卡在 maxThin 外被判成车身件 → 车轮没被移除 + 轮位不校准，
 *   「原车轮」和「新轮毂」同时留在场景里（用户反馈"位置还是错的"的根因）。
 *
 *   放宽到 0.65 是安全的，因为三条判据是**与**关系，圆度（≥0.75）早已把车身挡在外面：
 *   同一辆车的车身 root.0 = 2.159×1.261×4.600 → 圆度仅 0.274，与车轮不是一个量级。
 *   真车轮因宽胎/大扁平比落在 0.55~0.65 属正常（355mm 胎宽 / 632mm 外径 ≈ 0.57），
 *   再往上（>0.65）就接近球体、不是车轮形态了。
 *   改动后请用 `node scripts/_qa-bang-axle.mjs` 跑全样本确认无新增误判。
 */

export const WHEEL_RULES = {
  minRoundness: 0.75,
  minThin: 0.15,
  maxThin: 0.65,
  minRel: 0.1,
  maxRel: 0.45,
};

/**
 * @param {number[]} dims 包围盒三边（任意顺序，内部会排序）
 * @param {number} carLength 整车长度，用于尺度判定；传 0 表示未知（会跳过尺度项）
 * @returns {{kind:'wheel'|'other', score:number, roundness:number, thin:number, rel:number, diameter:number}}
 */
export function classifyDims(dims, carLength = 0) {
  const d = (Array.isArray(dims) ? dims : []).map((v) => Number(v) || 0).filter((v) => v >= 0);
  if (d.length < 3 || !d[0]) {
    return { kind: 'other', score: 0, roundness: 0, thin: 1, rel: 0, diameter: 0 };
  }

  const sorted = [...d].sort((a, b) => b - a);
  const [d1, d2, d3] = sorted;

  const diameter = (d1 + d2) / 2;
  const roundness = d1 > 0 ? d2 / d1 : 0;
  const thin = diameter > 0 ? d3 / diameter : 1;
  const rel = carLength > 0 ? diameter / carLength : 0;

  const okRound = roundness >= WHEEL_RULES.minRoundness;
  const okThin = thin >= WHEEL_RULES.minThin && thin <= WHEEL_RULES.maxThin;
  // 车长未知时无法判尺度，放宽通过（由调用方保证传了车长）
  const okSize = carLength > 0 ? rel >= WHEEL_RULES.minRel && rel <= WHEEL_RULES.maxRel : true;

  let score = 0;
  if (okRound) score += roundness;
  if (okThin) score += 1 - Math.abs(thin - 0.35) / 0.35;
  if (okSize && carLength > 0) score += 1 - Math.abs(rel - 0.24) / 0.24;

  return {
    kind: okRound && okThin && okSize ? 'wheel' : 'other',
    score,
    roundness,
    thin,
    rel,
    diameter,
  };
}
