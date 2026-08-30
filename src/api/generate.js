/**
 * generate.js — 前端生成管线（全自动：选图即开始，无需二次点击）
 *
 * 流程：
 *   选图 → 前端压缩（≤2048px / JPEG 0.9，保留足够轮廓与纹理细节给图生 3D）
 *        → POST /api/generate（SSE 持续回传进度）
 *        → 拿到 GLB 地址返回给调用方
 */

/** 把图片压到长边不超过 maxSide 的 JPEG dataURL */
export async function shrinkImage(file, maxSide = 2048, quality = 0.9) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    // 极端兜底：不压缩，直接 FileReader
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * 精度档位单一真值（前端）。后端 server/index.mjs 同步一份等价表。
 *
 * ⚠️ 红线：extreme 档 faceCount / maxSide 均为「待实测占位值」，
 *    探顶矩阵（scripts/_probe-rim-matrix.mjs）通过前**上线默认走 high**，
 *    禁止写死更高值（faceCount 真上限未知，写死可能触发生成 FAIL）。
 *   - standard 标准：当前默认，安全
 *   - high    高精：探顶前上线默认档
 *   - extreme 极限：待实测占位，探顶通过前不启用
 */
export const PRECISION_TIERS = {
  standard: { faceCount: 150000, model: '3.1', maxSide: 2048, quality: 0.9 },
  high: { faceCount: 225000, model: '3.1', maxSide: 2048, quality: 0.92 },
  extreme: { faceCount: 250000, model: '3.1', maxSide: 4096, quality: 0.95 },
};

/**
 * 生成失败的结构化错误。
 *
 * reason 决定 UI 走哪条恢复路径（对应设计文档 §3 错误分类矩阵）：
 *   'auth'    凭证失效 → 引导换票，点「我已更新」重试，不消耗额度
 *   'timeout' 本地等待超时但云端仍在跑 → 可带 jobId 续等，不重新提交、不重复扣额度
 *   'quota'   当日额度/次数用完 → 提示明天再试或改用演示模型，不重复提交
 *   'fail'    云端生成失败 / 网络问题 → 同参数重试
 *
 * 关键约束：任何 reason 都不会自动降级到演示模型，是否改用演示模型由用户显式点击决定。
 */
export class GenerateError extends Error {
  constructor(message, { reason = 'fail', detail = '', jobId = '', tokenId = '', images = null } = {}) {
    super(message);
    this.name = 'GenerateError';
    this.reason = reason;
    this.detail = detail;
    this.jobId = jobId;
    this.tokenId = tokenId; // 被云端拒掉的那张票的短哈希，用来判断用户有没有真的换票
    this.images = images; // 已压缩好的图，续等/重试时直接复用，不用再压一遍
  }
}

/** 把 File[] 压缩成后端要的 [{name, dataUrl}]，顺带回报进度 */
async function prepareImages(files, onProgress, maxSide = 2048, quality = 0.9) {
  const list = Array.from(files || []);
  if (!list.length) throw new GenerateError('请先选择照片', { reason: 'fail' });

  onProgress?.({ stage: 'prepare', progress: 0.02, message: `压缩 ${list.length} 张照片…` });
  const images = [];
  for (let i = 0; i < list.length; i++) {
    const dataUrl = await shrinkImage(list[i], maxSide, quality);
    images.push({ name: list[i].name, dataUrl });
    onProgress?.({
      stage: 'prepare',
      progress: 0.02 + ((i + 1) / list.length) * 0.06,
      message: `已处理 ${i + 1}/${list.length} 张`,
    });
  }
  return images;
}

/**
 * 调用生成接口，通过 SSE 实时回调进度。
 *
 * @param {Object} args
 * @param {'car'|'wheel'} args.kind
 * @param {FileList|File[]=} args.files       新生成时传原始文件
 * @param {Array=} args.images                续等/重试时传上一轮已压缩好的图
 * @param {string=} args.resumeJobId          续等已提交的云端任务（跳过重新提交）
 * @param {string=} args.engine               生成引擎：'hunyuan' | 'hyper3d' | 'higen3d'
 * @param {(s:{stage:string,progress:number,message:string})=>void} args.onProgress
 * @param {AbortSignal=} args.signal
 * @returns {Promise<{url:string, mode:'live'|'demo', kind:string, bytes?:number}>}
 * @throws {GenerateError}
 */
export async function generateModel({
  kind,
  files,
  images: preset,
  resumeJobId,
  title,
  precision,
  engine,
  onProgress,
  signal,
}) {
  // 精度档位 → 面数 / 模型 / 输入分辨率 / 质量；未指定或非法时回退标准档（安全）
  const tier = PRECISION_TIERS[precision] || PRECISION_TIERS.standard;

  // 续等时可以完全没有图；否则用现成的压缩结果（按档位 maxSide/quality 压缩），没有才现压
  const images = preset || (resumeJobId ? [] : await prepareImages(files, onProgress, tier.maxSide, tier.quality));

  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    // 当前仅支持图生 3D。文生 3D 接入时再传 prompt，否则混元会报
    // "Prompt 和 ImageBase64、ImageUrl 不能同时存在"。
    body: JSON.stringify({
      kind,
      images,
      resumeJobId: resumeJobId || undefined,
      title: title || undefined,
      precision: precision || undefined,
      engine: engine || undefined,
      faceCount: tier.faceCount,
      model: tier.model,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new GenerateError(`服务返回 ${res.status}`, {
      reason: 'fail',
      detail: text.slice(0, 200),
      images,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;

      let payload;
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }

      // 三类终止态各走各的恢复路径，都不自动降级演示模型
      if (payload.stage === 'auth_error') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '凭证已失效', {
          reason: 'auth',
          detail: payload.detail || '',
          tokenId: payload.tokenId || '',
          images,
        });
      }
      if (payload.stage === 'timeout') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '生成超时（云端任务仍在继续）', {
          reason: 'timeout',
          jobId: payload.detail || resumeJobId || '',
          images,
        });
      }
      if (payload.stage === 'quota_exceeded') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '今日额度已用完', {
          reason: 'quota',
          detail: payload.detail || '',
          images,
        });
      }
      if (payload.stage === 'error') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '生成失败', {
          reason: 'fail',
          detail: payload.detail || '',
          images,
        });
      }

      onProgress?.(payload);

      if (payload.stage === 'done' && payload.result) {
        reader.cancel().catch(() => {});
        return payload.result;
      }
    }
  }

  throw new GenerateError('连接中断，生成流意外结束', { reason: 'fail', images });
}

/**
 * 查询后端当前运行模式。
 * 返回 { ok, mode:'live'|'demo', expiresAt?:string }
 * expiresAt 是凭证预计失效时刻（ISO8601）：凭证文件写了第二行就是精确值，
 * 没写则由后端按"文件修改时间 + 16h"估算。
 *
 * 后端每次请求都重新读凭证文件，所以换票后直接重查即可，不用重启服务。
 */
export async function health() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    return await r.json();
  } catch {
    return { ok: false, mode: 'unknown' };
  }
}

/**
 * 调用后端 /api/recognize 识别车型。
 * 入参 files 为 FileList/File[]，内部压缩第一张后发送。
 * 返回 { available, brand, model, year, trim, fullName, confidence, raw } 或
 *       { available:false, reason:'no-key'|'auth'|'error', detail? }
 */
export async function recognize(files) {
  const list = Array.from(files || []);
  if (!list.length) return { available: false, reason: 'error', detail: '缺少图片' };
  const dataUrl = await shrinkImage(list[0]);
  const r = await fetch('/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: [{ dataUrl }] }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { available: false, reason: 'error', detail: `HTTP ${r.status} ${t.slice(0, 120)}` };
  }
  return await r.json();
}

/**
 * BANG 拆解：把整车/部件模型拆成多个独立部件 GLB。
 *
 * 与 generateModel 共享同一套 SSE 阶段契约（submit/accepted/polling/downloading/done/
 * error/auth_error/quota_exceeded/timeout），只在 done 时由 payload.result.parts 携带
 * 多个部件 [{ name, url, index }]。
 *
 * @param {Object} args
 * @param {string} args.modelUrl  要拆解的模型地址：/api/asset/:name 或 /models/xxx.glb 或 Hyper3D asset_id
 * @param {number=} args.strength 拆解强度 2–12，默认 5（越大越碎，支持递归）
 * @param {'Basic'|'High'=} args.resolution  贴图分辨率 Basic=2K / High=4K，默认 Basic
 * @param {'PBR'|'Shaded'|'All'|'None'=} args.material 材质，默认 PBR
 * @param {string=} args.geometryFileFormat 默认 glb
 * @param {(s:{stage:string,progress:number,message:string})=>void} args.onProgress
 * @param {AbortSignal=} args.signal
 * @returns {Promise<{url:string, mode:'live'|'demo', kind:'bang', parts:Array<{name:string,url:string,index:number}>}>}
 * @throws {GenerateError}
 */
export async function bangModel({
  modelUrl,
  strength = 5,
  resolution = 'Basic',
  material = 'PBR',
  geometryFileFormat = 'glb',
  onProgress,
  signal,
}) {
  const res = await fetch('/api/bang', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      modelUrl,
      strength,
      resolution,
      material,
      geometryFileFormat,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new GenerateError(`服务返回 ${res.status}`, {
      reason: 'fail',
      detail: text.slice(0, 200),
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;

      let payload;
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }

      // 三类终止态各走各的恢复路径，都不自动降级演示模型
      if (payload.stage === 'auth_error') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '凭证已失效', {
          reason: 'auth',
          detail: payload.detail || '',
          tokenId: payload.tokenId || '',
        });
      }
      if (payload.stage === 'timeout') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '拆解超时（云端任务仍在继续）', {
          reason: 'timeout',
          jobId: payload.detail || '',
        });
      }
      if (payload.stage === 'quota_exceeded') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '今日额度已用完', {
          reason: 'quota',
          detail: payload.detail || '',
        });
      }
      if (payload.stage === 'error') {
        reader.cancel().catch(() => {});
        throw new GenerateError(payload.message || '拆解失败', {
          reason: 'fail',
          detail: payload.detail || '',
        });
      }

      onProgress?.(payload);

      if (payload.stage === 'done' && payload.result) {
        reader.cancel().catch(() => {});
        return payload.result;
      }
    }
  }

  throw new GenerateError('连接中断，拆解流意外结束', { reason: 'fail' });
}
