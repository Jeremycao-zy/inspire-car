/**
 * rodinPrompt.mjs — Hyper3D Rodin 调用提示词规则（业务调度层）
 *
 * 职责：每次图生 3D 调用自动输出适配 Hyper3D 的专业 prompt。
 *   · 通用基础模板（所有任务必拼）
 *   · 分支1 wheel：识别主体为轮毂，禁止整车化，输出独立可拆装轮毂
 *   · 分支2 car  ：整车车身，预留车轮安装接口位，禁止默认红漆
 *
 * 任务类型由上传入口决定（整车面板 → car / 轮毂面板 → wheel），
 * 这是「自动区分轮毂图 / 整车图」的唯一真值来源，提示词分支跟随 kind，
 * 从机制上保证轮毂图不会被当成整车、整车图保留轮毂替换接口。
 *
 * 本模块为纯函数（无 IO），方便单测与复用。
 */

/** 通用基础 prompt 模板：所有生成任务自动拼接 */
export const BASE_PROMPT =
  'high-precision 3D car asset, PBR rendering, clean UV, raw material surface, no baked paint color, ' +
  'clean mesh, production-ready';

/** 分支1 追加词：轮毂任务 */
export const WHEEL_PROMPT_ADDON =
  'only car wheel rim, no car body, standalone wheel rim model, separable mesh structure, ' +
  'mesh can be detached and assembled, precise rim geometry, bolt hole accurate, hub bore complete, ' +
  'no car chassis, no vehicle body';

/** 分支2 追加词：整车任务 */
export const CAR_PROMPT_ADDON =
  'complete car body model, wheel mounting positions reserved, preserve real L/W/H ratios from input, ' +
  'no default red paint, raw material texture, placeholder wheel mounting positions, ' +
  'front along positive X axis, side profile on Z axis, ground plane horizontal, no rotation';

/**
 * 构建发送给 Hyper3D Rodin 的完整英文 prompt。
 *
 * @param {'car'|'wheel'} kind 任务类型（入口即分类：整车面板/轮毂面板）
 * @param {string=} userExtra 用户附加描述（可选，拼在末尾，不覆盖规则词）
 * @returns {string} 完整英文 prompt
 */
const MAX_PROMPT_LEN = 1024;
const EXTRA_PREFIX = 'additional requirements: ';

export function buildRodinPrompt(kind, userExtra = '') {
  const addon = kind === 'wheel' ? WHEEL_PROMPT_ADDON : CAR_PROMPT_ADDON;
  const extra = String(userExtra || '').trim();
  const base = [BASE_PROMPT, addon];
  if (extra) base.push(`${EXTRA_PREFIX}${extra}`);
  let prompt = base.join(', ');
  if (prompt.length > MAX_PROMPT_LEN) {
    // 优先保留基础规则词，截断用户附加描述
    const reserve = `${BASE_PROMPT}, ${addon}`;
    const budget = MAX_PROMPT_LEN - reserve.length - 2 - EXTRA_PREFIX.length;
    const safeExtra = extra.slice(0, Math.max(0, budget));
    prompt = safeExtra ? `${reserve}, ${EXTRA_PREFIX}${safeExtra}` : reserve;
  }
  return prompt;
}

/**
 * 业务执行简短说明（中文，前端进度区展示 ② 段）。
 * 说明任务类型与后续动作：整车=预留安装位；轮毂=独立可拆装，等待替换装车。
 *
 * @param {'car'|'wheel'} kind
 * @returns {string}
 */
export function describeTask(kind) {
  if (kind === 'wheel') {
    return '【轮毂任务】识别主体为轮毂（非整车）。输出独立可拆分轮毂网格，不带车身；生成完成后自动对齐安装到整车预留车轮点位，并开放 J 值 / ET / 中心孔 / PCD / 轮胎规格调节。';
  }
  return '【整车任务】识别主体为整车。执行替换逻辑（不新增第二台车），原车车轮为占位安装位并保留轮毂安装接口；坐标归一化、地面贴合；初始不烘焙车漆颜色，展示原始 PBR 材质贴图。';
}
