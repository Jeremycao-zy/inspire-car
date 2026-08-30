/**
 * environments.js — 场景预设（环境光照 / 灯光组 / 地面 / 网格）
 *
 * 设计目标（直接对应用户反馈「我需要这个模型所在环境的光源有多个，不然看不清背光面」）：
 *   1) 每个场景 ≥5 盏灯，且必须包含**专门的背光/轮廓光**，强度 ≥1.0。
 *      之前 viewer.js 只有 hemi 0.55 + key 2.1 + fill 0.7 + rim 0.5，
 *      背光只有 0.5，等于没有 —— 这是背光面发黑的直接原因。
 *   2) 每个场景 ≥2 盏投影灯，接触阴影才立体。
 *   3) 环境贴图全部程序化生成（发光板 + 房间外壳 → PMREM），
 *      **不依赖任何外网 HDRI**，离线可用。
 *
 * 灯光的角色约定：
 *   key     主光   —— 决定主受光面
 *   fill    补光   —— 抬暗部，避免死黑
 *   rim     背光   —— 从车后打亮轮廓/背光面（用户诉求的核心）
 *   bounce  反弹光 —— 低角度，模拟地面/墙面反弹
 *   accent  染色光 —— 霓虹 / 色调点缀
 *   ambient 环境光 —— 整体底噪，防止全黑
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/*                            预设数据                                  */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} LightSpec
 * @property {string} id
 * @property {string} label
 * @property {string} role         角色说明（面板显示）
 * @property {'directional'|'point'|'spot'|'hemisphere'|'ambient'} type
 * @property {number} [color]
 * @property {number} [sky]        hemisphere 专用
 * @property {number} [ground]     hemisphere 专用
 * @property {number} intensity
 * @property {number[]} [pos]      [x, y, z]
 * @property {number[]} [target]   directional / spot 的朝向点
 * @property {boolean} [castShadow]
 * @property {Object}  [shadow]    { mapSize, area, near, far, bias, normalBias }
 * @property {number}  [distance]  point / spot
 * @property {number}  [decay]     point / spot
 * @property {number}  [angle]     spot
 * @property {number}  [penumbra]  spot
 * @property {number}  [min]       面板滑杆下限
 * @property {number}  [max]       面板滑杆上限
 * @property {number}  [step]      面板滑杆步长
 * @property {boolean} [enabled]
 */

const SHADOW_WIDE = { mapSize: 2048, area: 9, near: 1, far: 42, bias: -0.0005, normalBias: 0.02 };
const SHADOW_SOFT = { mapSize: 1024, area: 7, near: 1, far: 40, bias: -0.0008, normalBias: 0.03 };

/** @type {Array<Object>} */
export const ENVIRONMENTS = [
  /* ================================ 影棚 ================================ */
  {
    id: 'studio',
    label: '影棚',
    hint: '三点布光 + 双侧柔光箱，最稳的看车光',
    exposure: 1.15,
    background: 0x14171c,
    fog: { color: 0x14171c, near: 26, far: 72 },
    envSigma: 0.035,
    env: {
      roomSize: [26, 15, 26],
      shell: 0x171a1f,
      floor: 0x0d0f12,
      floorIntensity: 0.9,
      panels: [
        { pos: [0, 7.0, 0], size: [15, 11], color: 0xffffff, intensity: 4.6 }, // 顶部柔光箱
        { pos: [-12, 3.2, 2], size: [11, 8], color: 0xdce9ff, intensity: 2.3 }, // 左补光
        { pos: [12, 3.2, -2], size: [11, 8], color: 0xffffff, intensity: 2.8 }, // 右背光
        { pos: [0, 3.4, -12.4], size: [17, 3.4], color: 0xffffff, intensity: 3.2 }, // 后侧轮廓条
        { pos: [0, 0.5, 12.4], size: [13, 2.2], color: 0xffffff, intensity: 0.9 }, // 前方低反弹
      ],
    },
    ground: { color: 0x171a1f, roughness: 0.78, metalness: 0.08 },
    shadowOpacity: 0.42,
    grid: { enabled: true, c1: 0x2c323c, c2: 0x1e222a, size: 40, div: 40, opacity: 0.5, y: 0.004 },
    lights: [
      { id: 'key', label: '主光', role: '右前上 · 投影', type: 'directional', color: 0xffffff, intensity: 2.6, pos: [6.5, 9.5, 5.5], castShadow: true, shadow: SHADOW_WIDE, min: 0, max: 6, step: 0.05 },
      { id: 'fill', label: '补光', role: '左前 · 抬暗部', type: 'directional', color: 0xa8c8ff, intensity: 1.6, pos: [-7.5, 4.5, -5.0], min: 0, max: 5, step: 0.05 },
      { id: 'rim', label: '背光', role: '正后 · 打亮背光面', type: 'directional', color: 0xffffff, intensity: 2.4, pos: [0.5, 3.2, -9.5], min: 0, max: 6, step: 0.05 },
      { id: 'rimL', label: '左后轮廓', role: '左后 · 投影', type: 'directional', color: 0xdfeaff, intensity: 1.7, pos: [-6.5, 5.5, -7.5], castShadow: true, shadow: SHADOW_SOFT, min: 0, max: 5, step: 0.05 },
      { id: 'bounce', label: '地面反弹', role: '低角度 · 底盘补光', type: 'directional', color: 0xc8d6ea, intensity: 1.05, pos: [-1.5, 0.6, 7.5], min: 0, max: 4, step: 0.05 },
      { id: 'hemi', label: '半球光', role: '天顶/地面色', type: 'hemisphere', sky: 0xbcd4ff, ground: 0x20242c, intensity: 0.95, min: 0, max: 3, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0xffffff, intensity: 0.34, min: 0, max: 2, step: 0.02 },
    ],
  },

  /* ================================ 展厅 ================================ */
  {
    id: 'showroom',
    label: '展厅',
    hint: '镜面地台 + 顶部灯带，反射感最强',
    exposure: 1.05,
    background: 0x0e1013,
    fog: { color: 0x0e1013, near: 24, far: 68 },
    envSigma: 0.03,
    env: {
      roomSize: [28, 16, 28],
      shell: 0x101318,
      floor: 0x0a0c10,
      floorIntensity: 1.6,
      panels: [
        { pos: [-3.6, 7.4, 0], size: [1.4, 20], color: 0xffffff, intensity: 5.2, roll: Math.PI / 2 },
        { pos: [3.6, 7.4, 0], size: [1.4, 20], color: 0xffffff, intensity: 5.2, roll: Math.PI / 2 },
        { pos: [-8.0, 7.4, 0], size: [1.2, 20], color: 0xdfe9f5, intensity: 3.0, roll: Math.PI / 2 },
        { pos: [8.0, 7.4, 0], size: [1.2, 20], color: 0xdfe9f5, intensity: 3.0, roll: Math.PI / 2 },
        { pos: [0, 2.6, -13.4], size: [22, 9], color: 0x2c3a4c, intensity: 1.5 },
        { pos: [-13.4, 3.2, 0], size: [18, 7], color: 0x35434f, intensity: 1.1 },
      ],
    },
    ground: { color: 0x0d0f13, roughness: 0.22, metalness: 0.45 },
    shadowOpacity: 0.5,
    grid: { enabled: true, c1: 0x2f5f7a, c2: 0x1b2a34, size: 44, div: 44, opacity: 0.42, y: 0.004 },
    lights: [
      { id: 'key', label: '主光', role: '顶部偏右 · 投影', type: 'directional', color: 0xffffff, intensity: 2.5, pos: [5.0, 11.0, 6.0], castShadow: true, shadow: SHADOW_WIDE, min: 0, max: 6, step: 0.05 },
      { id: 'fill', label: '补光', role: '左前 · 抬暗部', type: 'directional', color: 0xb9d3ff, intensity: 1.5, pos: [-8.5, 5.0, 4.5], min: 0, max: 5, step: 0.05 },
      { id: 'rim', label: '背光', role: '正后 · 打亮背光面', type: 'directional', color: 0xffffff, intensity: 2.2, pos: [0.0, 4.2, -10.5], min: 0, max: 6, step: 0.05 },
      { id: 'rimR', label: '右后轮廓', role: '右后 · 投影', type: 'directional', color: 0xe6f0ff, intensity: 1.7, pos: [-5.5, 6.5, -8.0], castShadow: true, shadow: SHADOW_SOFT, min: 0, max: 5, step: 0.05 },
      { id: 'bounce', label: '地台反弹', role: '低角度 · 侧裙补光', type: 'directional', color: 0x9fc4e8, intensity: 1.15, pos: [2.0, 0.7, 6.5], min: 0, max: 4, step: 0.05 },
      { id: 'hemi', label: '半球光', role: '冷调环境', type: 'hemisphere', sky: 0xa9c8f0, ground: 0x14181e, intensity: 1.0, min: 0, max: 3, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0xffffff, intensity: 0.3, min: 0, max: 2, step: 0.02 },
    ],
  },

  /* ================================ 车库 ================================ */
  {
    id: 'garage',
    label: '车库',
    hint: '暖白日光灯管 + 水泥地，最接地气',
    exposure: 1.12,
    background: 0x131210,
    fog: { color: 0x131210, near: 18, far: 54 },
    envSigma: 0.045,
    env: {
      roomSize: [24, 12, 24],
      shell: 0x17150f,
      floor: 0x121110,
      floorIntensity: 0.8,
      panels: [
        { pos: [-3.2, 5.4, 0], size: [0.8, 13], color: 0xfff1d6, intensity: 4.2, roll: Math.PI / 2 },
        { pos: [3.2, 5.4, 0], size: [0.8, 13], color: 0xfff1d6, intensity: 4.2, roll: Math.PI / 2 },
        { pos: [0, 2.6, -11.4], size: [11, 5.5], color: 0xffb066, intensity: 2.0 }, // 卷帘门透进来的暖光
        { pos: [-11.4, 3.0, 0], size: [13, 6], color: 0x6f5c44, intensity: 0.9 },
        { pos: [11.4, 3.0, 0], size: [13, 6], color: 0x5d5346, intensity: 0.8 },
      ],
    },
    ground: { color: 0x1b1a18, roughness: 0.92, metalness: 0.04 },
    shadowOpacity: 0.46,
    grid: { enabled: true, c1: 0x33302a, c2: 0x23211d, size: 36, div: 36, opacity: 0.34, y: 0.004 },
    lights: [
      { id: 'key', label: '主灯管', role: '右上 · 投影', type: 'directional', color: 0xfff0d4, intensity: 2.3, pos: [4.5, 8.0, 4.0], castShadow: true, shadow: SHADOW_WIDE, min: 0, max: 6, step: 0.05 },
      { id: 'tubeL', label: '左灯管', role: '左顶 · 点光源', type: 'point', color: 0xffeec9, intensity: 1.5, pos: [-3.2, 4.6, 2.6], distance: 16, decay: 2, min: 0, max: 8, step: 0.05 },
      { id: 'tubeR', label: '右灯管', role: '右顶 · 点光源 · 投影', type: 'point', color: 0xffeec9, intensity: 1.5, pos: [3.2, 4.6, -2.6], distance: 16, decay: 2, castShadow: true, shadow: { mapSize: 1024, area: 8, near: 0.5, far: 26, bias: -0.001, normalBias: 0.03 }, min: 0, max: 8, step: 0.05 },
      { id: 'rim', label: '背光', role: '正后 · 打亮背光面', type: 'directional', color: 0xffd9a0, intensity: 1.9, pos: [0.0, 3.6, -9.0], min: 0, max: 6, step: 0.05 },
      { id: 'fill', label: '补光', role: '左后 · 冷调补暗部', type: 'directional', color: 0x9fb4cc, intensity: 1.3, pos: [-6.5, 4.2, -5.5], min: 0, max: 5, step: 0.05 },
      { id: 'bounce', label: '水泥地反弹', role: '低角度 · 底盘补光', type: 'directional', color: 0xb9a98c, intensity: 1.0, pos: [1.0, 0.5, 7.0], min: 0, max: 4, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0xffe9c8, intensity: 0.28, min: 0, max: 2, step: 0.02 },
    ],
  },

  /* ============================== 户外日间 ============================== */
  {
    id: 'outdoor',
    label: '户外',
    hint: '正午日光 + 天空光，最接近实车外拍',
    exposure: 1.0,
    background: 0x9dbdd8,
    fog: { color: 0xb4cadd, near: 34, far: 96 },
    envSigma: 0.02,
    env: {
      roomSize: [70, 40, 70],
      shell: 0x9dbdd8,
      floor: 0x5c6670,
      floorIntensity: 1.0,
      panels: [
        { pos: [12, 26, 10], size: [10, 10], color: 0xfff8ea, intensity: 9.0 }, // 太阳
        { pos: [-14, 16, -12], size: [22, 14], color: 0xcfe2f2, intensity: 1.6 }, // 天空亮区
        { pos: [0, 1.0, 0], size: [46, 46], color: 0x6b7580, intensity: 0.55 }, // 地面反弹
      ],
    },
    ground: { color: 0x4c535c, roughness: 0.94, metalness: 0.03 },
    shadowOpacity: 0.34,
    grid: { enabled: false },
    lights: [
      { id: 'sun', label: '太阳', role: '高角度 · 投影', type: 'directional', color: 0xfff6e4, intensity: 3.0, pos: [9.0, 15.0, 7.0], castShadow: true, shadow: { mapSize: 2048, area: 10, near: 1, far: 50, bias: -0.0005, normalBias: 0.02 }, min: 0, max: 8, step: 0.05 },
      { id: 'sky', label: '天空光', role: '半球 · 蓝天地 bounce', type: 'hemisphere', sky: 0xbcdcf5, ground: 0x6a6f74, intensity: 1.7, min: 0, max: 4, step: 0.05 },
      { id: 'rim', label: '背光', role: '正后 · 打亮背光面', type: 'directional', color: 0xeaf3ff, intensity: 1.6, pos: [-2.0, 5.0, -12.0], min: 0, max: 6, step: 0.05 },
      { id: 'fill', label: '补光', role: '左前 · 投影', type: 'directional', color: 0xdce9f7, intensity: 1.25, pos: [-10.0, 6.5, 3.5], castShadow: true, shadow: SHADOW_SOFT, min: 0, max: 5, step: 0.05 },
      { id: 'bounce', label: '地面反弹', role: '低角度 · 底盘补光', type: 'directional', color: 0xb9c2cc, intensity: 1.0, pos: [0.0, 1.2, 9.0], min: 0, max: 4, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0xdceaff, intensity: 0.45, min: 0, max: 2, step: 0.02 },
    ],
  },

  /* ================================ 黄昏 ================================ */
  {
    id: 'sunset',
    label: '黄昏',
    hint: '低角度暖阳 + 冷暖对撞，轮廓最立体',
    exposure: 1.15,
    background: 0x2b1f2c,
    fog: { color: 0x51304a, near: 20, far: 66 },
    envSigma: 0.03,
    env: {
      roomSize: [60, 34, 60],
      shell: 0x3a2a42,
      floor: 0x2a2129,
      floorIntensity: 0.9,
      panels: [
        { pos: [-20, 3.0, 8], size: [12, 12], color: 0xff9a3c, intensity: 8.0 }, // 低垂的落日
        { pos: [16, 12, -14], size: [26, 16], color: 0x4a6b9c, intensity: 1.5 }, // 冷调天空
        { pos: [0, 1.0, 0], size: [40, 40], color: 0x4a3a44, intensity: 0.5 },
      ],
    },
    ground: { color: 0x241d24, roughness: 0.7, metalness: 0.12 },
    shadowOpacity: 0.4,
    grid: { enabled: true, c1: 0x5a3a52, c2: 0x2e2029, size: 40, div: 40, opacity: 0.3, y: 0.004 },
    lights: [
      { id: 'sun', label: '落日', role: '低角度 · 长投影', type: 'directional', color: 0xff9b45, intensity: 3.2, pos: [-11.0, 3.0, 6.0], castShadow: true, shadow: { mapSize: 2048, area: 12, near: 1, far: 54, bias: -0.0006, normalBias: 0.025 }, min: 0, max: 8, step: 0.05 },
      { id: 'sky', label: '天空光', role: '暖顶 / 冷地', type: 'hemisphere', sky: 0xffb27a, ground: 0x2a2740, intensity: 1.35, min: 0, max: 4, step: 0.05 },
      { id: 'rim', label: '背光', role: '右后冷光 · 打亮背光面', type: 'directional', color: 0x7fa8ff, intensity: 2.1, pos: [8.5, 4.5, -7.0], min: 0, max: 6, step: 0.05 },
      { id: 'fill', label: '补光', role: '左前 · 抬暗部', type: 'directional', color: 0xa9b6d8, intensity: 1.3, pos: [-6.0, 5.5, 8.0], min: 0, max: 5, step: 0.05 },
      { id: 'bounce', label: '地面反弹', role: '低角度 · 暖色底盘光', type: 'directional', color: 0xff9e6a, intensity: 1.1, pos: [3.0, 0.9, 8.5], min: 0, max: 4, step: 0.05 },
      { id: 'backFill', label: '后方补光', role: '正后 · 投影', type: 'directional', color: 0xc98cff, intensity: 1.15, pos: [4.0, 5.5, 9.5], castShadow: true, shadow: SHADOW_SOFT, min: 0, max: 5, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0xffc9a0, intensity: 0.32, min: 0, max: 2, step: 0.02 },
    ],
  },

  /* ================================ 夜景 ================================ */
  {
    id: 'night',
    label: '夜景',
    hint: '霓虹双色 + 强背光，湿地反光最出片',
    exposure: 1.08,
    background: 0x05070b,
    fog: { color: 0x070a10, near: 12, far: 46 },
    envSigma: 0.05,
    env: {
      roomSize: [30, 16, 30],
      shell: 0x080b12,
      floor: 0x05070b,
      floorIntensity: 1.4,
      panels: [
        { pos: [-9.0, 3.4, 4.0], size: [3.0, 9], color: 0xff3fa4, intensity: 3.4 }, // 品红霓虹
        { pos: [9.0, 3.4, -4.0], size: [3.0, 9], color: 0x35e8ff, intensity: 3.4 }, // 青色霓虹
        { pos: [0, 6.6, 0], size: [12, 8], color: 0x9fb6ff, intensity: 1.1 }, // 顶部月光
        { pos: [0, 2.4, -14.0], size: [18, 4], color: 0x2a4a7a, intensity: 1.6 }, // 远处楼体灯
      ],
    },
    ground: { color: 0x090b11, roughness: 0.34, metalness: 0.55 },
    shadowOpacity: 0.5,
    grid: { enabled: true, c1: 0x1d5f74, c2: 0x101a22, size: 40, div: 40, opacity: 0.4, y: 0.004 },
    lights: [
      { id: 'key', label: '主光', role: '右上 · 冷白 · 投影', type: 'directional', color: 0xcfe2ff, intensity: 1.7, pos: [5.0, 8.5, 4.5], castShadow: true, shadow: SHADOW_WIDE, min: 0, max: 6, step: 0.05 },
      { id: 'neonA', label: '霓虹 A', role: '品红 · 左侧染色', type: 'point', color: 0xff3fa4, intensity: 1.9, pos: [-4.2, 2.3, 3.2], distance: 15, decay: 2, min: 0, max: 8, step: 0.05 },
      { id: 'neonB', label: '霓虹 B', role: '青色 · 右侧染色', type: 'point', color: 0x35e8ff, intensity: 1.9, pos: [4.2, 2.3, -3.2], distance: 15, decay: 2, min: 0, max: 8, step: 0.05 },
      { id: 'rim', label: '背光', role: '正后 · 打亮背光面', type: 'directional', color: 0x8fd8ff, intensity: 2.3, pos: [0.5, 3.0, -9.5], min: 0, max: 6, step: 0.05 },
      { id: 'backFill', label: '后方补光', role: '左后 · 品红 · 投影', type: 'directional', color: 0xff7ac2, intensity: 1.6, pos: [-6.0, 4.5, -7.0], castShadow: true, shadow: SHADOW_SOFT, min: 0, max: 6, step: 0.05 },
      { id: 'hemi', label: '半球光', role: '夜空底噪', type: 'hemisphere', sky: 0x2a3a5c, ground: 0x05060a, intensity: 0.4, min: 0, max: 3, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0x6a86b8, intensity: 0.2, min: 0, max: 2, step: 0.02 },
    ],
  },

  /* ============================ 赛道（实景） ============================ */
  {
    id: 'racetrack',
    label: '赛道',
    hint: '室外赛道 · 起跑线 + 护栏 + 看台，最热血',
    exposure: 1.02,
    background: 0xbfe0fb,
    fog: { color: 0xcfe2f2, near: 60, far: 220 },
    sky: { top: 0x6ea8ef, horizon: 0xbfe0fb, bottom: 0xa9c8e6 },
    envSigma: 0.02,
    decor: 'racetrack',
    env: {
      roomSize: [120, 60, 120],
      shell: 0xbfe0fb,
      floor: 0x6f7681,
      floorIntensity: 1.0,
      panels: [
        { pos: [18, 34, 14], size: [16, 16], color: 0xfff8ea, intensity: 11.0 }, // 太阳
        { pos: [-22, 20, -18], size: [40, 22], color: 0xdaf0ff, intensity: 1.8 }, // 天空亮区
        { pos: [0, 1.0, 0], size: [80, 80], color: 0x8a9098, intensity: 0.6 }, // 地面反弹
      ],
    },
    ground: { color: 0x3a3d43, roughness: 0.92, metalness: 0.04 },
    shadowOpacity: 0.34,
    grid: { enabled: false },
    lights: [
      { id: 'sun', label: '太阳', role: '高角度 · 投影', type: 'directional', color: 0xfff6e4, intensity: 3.2, pos: [10.0, 16.0, 8.0], castShadow: true, shadow: { mapSize: 2048, area: 13, near: 1, far: 60, bias: -0.0005, normalBias: 0.02 }, min: 0, max: 8, step: 0.05 },
      { id: 'sky', label: '天空光', role: '半球 · 蓝天地 bounce', type: 'hemisphere', sky: 0xbcdcf5, ground: 0x6a6f74, intensity: 1.8, min: 0, max: 4, step: 0.05 },
      { id: 'rim', label: '背光', role: '正后 · 打亮背光面', type: 'directional', color: 0xeaf3ff, intensity: 1.7, pos: [-2.0, 5.0, -13.0], min: 0, max: 6, step: 0.05 },
      { id: 'fill', label: '补光', role: '左前 · 投影', type: 'directional', color: 0xdce9f7, intensity: 1.3, pos: [-11.0, 7.0, 4.0], castShadow: true, shadow: SHADOW_SOFT, min: 0, max: 5, step: 0.05 },
      { id: 'bounce', label: '地面反弹', role: '低角度 · 底盘补光', type: 'directional', color: 0xb9c2cc, intensity: 1.05, pos: [0.0, 1.3, 10.0], min: 0, max: 4, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0xdceaff, intensity: 0.5, min: 0, max: 2, step: 0.02 },
    ],
  },

  /* ========================== 欧洲城市（实景） ========================== */
  {
    id: 'eurocity',
    label: '欧城',
    hint: '欧洲街景 · 石砌广场 + 坡顶建筑 + 街灯',
    exposure: 1.04,
    background: 0xd7e6f6,
    fog: { color: 0xe2ebf4, near: 70, far: 240 },
    sky: { top: 0x8fb8ef, horizon: 0xd7e6f6, bottom: 0xc9d6e2 },
    envSigma: 0.025,
    decor: 'eurocity',
    env: {
      roomSize: [120, 60, 120],
      shell: 0xd7e6f6,
      floor: 0xb9b2a6,
      floorIntensity: 1.0,
      panels: [
        { pos: [14, 30, 12], size: [14, 14], color: 0xfff4e0, intensity: 9.5 }, // 暖阳
        { pos: [-20, 18, -16], size: [38, 20], color: 0xe4f1fb, intensity: 1.7 }, // 天空亮区
        { pos: [0, 1.0, 0], size: [80, 80], color: 0xb9b2a6, intensity: 0.55 }, // 地面反弹
      ],
    },
    ground: { color: 0xb9b2a6, roughness: 0.95, metalness: 0.02 },
    shadowOpacity: 0.32,
    grid: { enabled: false },
    lights: [
      { id: 'sun', label: '暖阳', role: '侧高 · 投影', type: 'directional', color: 0xfff1d8, intensity: 2.9, pos: [9.0, 13.0, 7.0], castShadow: true, shadow: { mapSize: 2048, area: 13, near: 1, far: 60, bias: -0.0005, normalBias: 0.02 }, min: 0, max: 8, step: 0.05 },
      { id: 'sky', label: '天空光', role: '半球 · 冷调环境', type: 'hemisphere', sky: 0xcfe2f5, ground: 0x9aa0a6, intensity: 1.7, min: 0, max: 4, step: 0.05 },
      { id: 'rim', label: '背光', role: '正后 · 打亮背光面', type: 'directional', color: 0xeef4ff, intensity: 1.6, pos: [-2.0, 4.5, -12.0], min: 0, max: 6, step: 0.05 },
      { id: 'fill', label: '补光', role: '左前 · 投影', type: 'directional', color: 0xe6eef8, intensity: 1.2, pos: [-10.0, 6.5, 4.5], castShadow: true, shadow: SHADOW_SOFT, min: 0, max: 5, step: 0.05 },
      { id: 'bounce', label: '地面反弹', role: '低角度 · 暖色底盘光', type: 'directional', color: 0xd8cbb0, intensity: 1.0, pos: [0.0, 1.2, 9.5], min: 0, max: 4, step: 0.05 },
      { id: 'ambient', label: '环境光', role: '整体底噪', type: 'ambient', color: 0xdfe7f2, intensity: 0.5, min: 0, max: 2, step: 0.02 },
    ],
  },
];

/** 默认场景 */
export const DEFAULT_ENVIRONMENT = 'studio';

/** 面板用的场景列表 */
export function listPresets() {
  return ENVIRONMENTS.map((p) => ({ id: p.id, label: p.label, hint: p.hint || '' }));
}

/** @param {string} id @returns {Object|null} */
export function getPreset(id) {
  return ENVIRONMENTS.find((p) => p.id === id) || null;
}

/** 每个场景的灯数 / 投影灯数 / 背光强度（自检与面板提示用） */
export function presetStats(preset) {
  const lights = preset.lights || [];
  const shadowLights = lights.filter((l) => l.castShadow);
  const backLights = lights.filter((l) => l.id === 'rim' || l.id === 'rimL' || l.id === 'rimR' || l.id === 'backFill');
  const maxBack = backLights.reduce((m, l) => Math.max(m, l.intensity), 0);
  return {
    id: preset.id,
    lights: lights.length,
    shadowLights: shadowLights.length,
    backLights: backLights.length,
    maxBackIntensity: maxBack,
  };
}

/* ------------------------------------------------------------------ */
/*                       程序化环境贴图（PMREM）                        */
/* ------------------------------------------------------------------ */

/**
 * 按预设搭一个「盒子房 + 发光板」的场景，交给 PMREMGenerator 卷积成环境贴图。
 * 全程程序化，不加载任何外部 HDRI。
 *
 * @param {Object} preset
 * @returns {THREE.Scene} 用完记得 disposeEnvScene()
 */
export function buildEnvScene(preset) {
  const env = preset.env;
  const scene = new THREE.Scene();
  const [rw, rh, rd] = env.roomSize;

  // 房间外壳（从内部看）
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(rw, rh, rd),
    new THREE.MeshBasicMaterial({ color: env.shell, side: THREE.BackSide })
  );
  scene.add(shell);

  // 环境地面（提供地面反弹色）
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(rw, rd),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(env.floor).multiplyScalar(env.floorIntensity ?? 1),
      side: THREE.DoubleSide,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -rh / 2 + 0.02;
  scene.add(floor);

  // 发光板（柔光箱 / 灯带 / 霓虹 / 太阳）
  for (const p of env.panels || []) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.color).multiplyScalar(p.intensity ?? 1),
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.size[0], p.size[1]), mat);
    mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
    if (p.rot) mesh.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
    else mesh.lookAt(0, 0, 0);
    if (p.roll) mesh.rotateZ(p.roll);
    scene.add(mesh);
  }

  return scene;
}

/** 释放 buildEnvScene 造出来的几何与材质 */
export function disposeEnvScene(root) {
  root?.traverse?.((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) m?.dispose?.();
  });
}
