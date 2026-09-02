/**
 * presetCar.js — 预设展示车的单一事实来源
 *
 * 之前 PRESET_CAR_URL 在 main.js / planPreview.js / garage.js 各写了一份字面量，
 * 换模型时要改三处、漏一处就出现「某个页面还是旧车」。集中到这里统一导出。
 *
 * 单独成文件（而不是继续放在 main.js）是为了避免循环依赖：
 *   main.js → garage.js → main.js
 * ES 模块虽然能处理环，但常量在环上求值时可能是 undefined。
 */

/**
 * 预设展示车模型路径。
 * 2026-09-02 起由 base_high_shaded.glb（单网格 shaded）换成 base_high_pbr.glb
 * （PBR：baseColor + normal + metallicRoughness）。两者都是「原样展示、不切轮」
 * 的第三方整车模型，仅作改装位置示意。PBR 版经选择性压缩（Draco 几何 +
 * 仅 baseColor 转 JPEG92，normal/metalRough 保持 PNG 无损），体积 55.6MB→18MB。
 */
export const PRESET_CAR_URL = '/models/base-high-pbr.glb';

/**
 * 历史遗留的预设车路径。
 * 用户 localStorage 里已保存的方案可能仍指向旧的 '/models/my-car.glb'，
 * 若不兼容，这些方案会被误判成「用户自己的车」→ 触发切轮（而这台 shaded
 * 单网格车一切就破）。所以旧路径同样视为预设车。
 */
const LEGACY_PRESET_URLS = ['/models/my-car.glb'];

/**
 * 旧路径 → 当前文件的映射。
 * my-car.glb 已删除（原为 base_high_shaded.glb 的压缩版，文件已换成原模型的
 * Draco 压缩版）。旧方案仍存着这个路径，加载时必须改写，否则会 404。
 */
const LEGACY_CAR_URL_MAP = {
  '/models/my-car.glb': PRESET_CAR_URL,
};

/** 把历史遗留路径改写成当前实际存在的 URL（无法识别的原样返回） */
export function normalizeCarUrl(url) {
  return LEGACY_CAR_URL_MAP[url] || url;
}

/** 该 URL 是否是「预设展示车」（而非用户自己的车） */
export function isPresetCarUrl(url) {
  return !url || url === PRESET_CAR_URL || LEGACY_PRESET_URLS.includes(url);
}
