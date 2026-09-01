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

/** 通用基础 prompt 模板：所有生成任务自动拼接（原文，勿改词序与拼写） */
export const BASE_PROMPT =
  'high-precision 3D asset, PBR physically-based rendering, high-fidelity texture mapping, ' +
  'accurate material restoration, clean UV unwrap, no baked paint color, raw material surface, ' +
  'high polygon detail, clean mesh, no redundant geometry, production-ready asset, ' +
  'for automotive modification application';

/** 分支1 追加词：轮毂任务（原文） */
export const WHEEL_PROMPT_ADDON =
  'only car wheel rim, no car body, standalone wheel rim model, separable mesh structure, ' +
  'mesh can be detached and assembled, precise rim geometry, bolt hole accurate, hub bore complete, ' +
  'no car chassis, no vehicle body';

/** 分支2 追加词：整车任务（原文） */
export const CAR_PROMPT_ADDON =
  'complete car body model, separate wheel mounting position reserved, wheel hub mounting interface ' +
  'retained, exact body proportions matching the reference car body (preserve real length to width ' +
  'and length to height ratios from the input image), no default red paint, raw material surface, ' +
  'do not bake fixed car paint color, keep original material texture, clean mesh, wheels are placeholder ' +
  'mounting positions, ready for hub replacement, strict front-facing orientation with the car front ' +
  '(headlights, hood, grille) pointing forward along the positive X axis, vehicle traveling ' +
  'direction along positive X axis, side profile visible on the Z axis, ground plane horizontal, ' +
  'no upside-down or sideways rotation, three-quarter view from front-left preferred';

/**
 * 构建发送给 Hyper3D Rodin 的完整英文 prompt。
 *
 * @param {'car'|'wheel'} kind 任务类型（入口即分类：整车面板/轮毂面板）
 * @param {string=} userExtra 用户附加描述（可选，拼在末尾，不覆盖规则词）
 * @returns {string} 完整英文 prompt
 */
export function buildRodinPrompt(kind, userExtra = '') {
  const addon = kind === 'wheel' ? WHEEL_PROMPT_ADDON : CAR_PROMPT_ADDON;
  const parts = [BASE_PROMPT, addon];
  const extra = String(userExtra || '').trim();
  if (extra) parts.push(`additional requirements: ${extra}`);
  return parts.join(', ');
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
