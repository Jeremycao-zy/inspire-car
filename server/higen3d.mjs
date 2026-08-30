/**
 * server/higen3d.mjs
 * HiGen3D (higen3d.com) 引擎适配器
 *
 * ⚠️ 重要前提：higen3d.com 的 API 技术文档不公开，仅在订阅 Studio 套餐
 * （$49/月，含 REST + webhook API 接入）后于控制台提供。
 * 因此本文件当前是「key 门控骨架」：submitJob / queryJob / download 的真实
 * 调用逻辑需在你订阅并把官方 API 文档发给我后填充。
 *
 * 订阅后需你提供的文档项（我会据此实现真实调用）：
 *   1. 提交任务 endpoint + 请求体字段（图片输入、模式 Fast/Quality/Best、输出 GLB 等）
 *   2. 状态查询方式：轮询 endpoint 还是 webhook 回调
 *   3. 结果下载 endpoint
 *   4. 认证方式（请求头如何携带 API Key）
 *   5. 错误码（尤其「认证失效 / 配额耗尽」对应的 code，用于决定走换票引导）
 */

import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.workbuddy',
  'tokens',
  'higen3d'
);
// 待官方文档确认实际 API 基址
const ENDPOINT = process.env.HIGEN3D_ENDPOINT || 'https://api.higen3d.com';

/** 读取 API Key：环境变量优先，其次文件（单行） */
export function getKey() {
  if (process.env.HIGEN3D_API_KEY) return process.env.HIGEN3D_API_KEY.trim();
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 引擎是否可用（已配置 key） */
export function available() {
  return Boolean(getKey());
}

/** 引擎尚未配置真实调用逻辑时抛出的错误（前端据此显示「待配置」） */
export class EngineNotConfigured extends Error {
  constructor() {
    super('HiGen3D 引擎待配置：请订阅 Studio 套餐并把官方 API 文档发给开发者');
    this.name = 'EngineNotConfigured';
    this.code = 'ENGINE_NOT_CONFIGURED';
  }
}

// TODO(订阅后填充)：以下三个函数需依据官方 API 文档实现
// 已知形态：REST 提交 +（轮询或 webhook）查询 + 下载 GLB；认证方式待文档。
export async function submitJob(/* { images, mode, kind } */) {
  throw new EngineNotConfigured();
}

export async function queryJob(/* jobId */) {
  throw new EngineNotConfigured();
}

export async function download(/* url */) {
  throw new EngineNotConfigured();
}

export const ENDPOINT_INFO = {
  ENDPOINT,
  configured: false,
  docSource: 'higen3d.com Studio 控制台（文档不公开）',
};
