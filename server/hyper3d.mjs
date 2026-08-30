/**
 * hyper3d.mjs — Hyper3D Rodin / BANG Node 客户端
 *
 * Base URL: https://api.hyper3d.com/api/v2
 * 鉴权：Bearer Token（与混元的 TC3-HMAC-SHA256 完全不同，无需签名）
 *   Authorization: Bearer ${RODIN_API_KEY}
 *
 * 任务生命周期（异步三步）：
 *   1) POST /rodin   (multipart) → { uuid(下载用), jobs.subscription_key(轮询用) }
 *   2) POST /status  (json)      → jobs[].status ∈ Waiting | Generating | Done | Failed
 *   3) POST /download(json)      → 返回下载地址列表（URL 会过期，必须立即拉到 Buffer）
 *
 * BANG 拆解：POST /bang (multipart)
 *   asset_id（Rodin 任务 uuid）与 model（上传模型文件）二选一；
 *   返回多个部件文件，用于把整车拆成车身 / 轮毂等可编辑子模型。
 *
 * 为什么必须走服务端：API Key 不能出现在浏览器，且 api.hyper3d.com 不允许任意源跨域。
 */

import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

/** 可用 HYPER3D_ENDPOINT 覆盖，便于自测时指向 mock 服务 */
export const ENDPOINT = process.env.HYPER3D_ENDPOINT || 'https://api.hyper3d.com/api/v2';

/* ------------------------- 凭证 ------------------------- */

/**
 * 优先级：环境变量 HYPER3D_API_KEY > ~/.workbuddy/tokens/hyper3d（首行）
 * 返回 { token, tokenId }，tokenId 是 key 的短哈希，只用于前端判断"是不是换了新 key"。
 */
export function resolveToken() {
  let token = '';
  if (process.env.HYPER3D_API_KEY) {
    token = process.env.HYPER3D_API_KEY.trim();
  } else {
    const p = path.join(process.env.HOME || '', '.workbuddy', 'tokens', 'hyper3d');
    try {
      token = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/)[0].trim();
    } catch {
      /* 未配置 */
    }
  }
  return {
    token,
    tokenId: token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 8) : '',
  };
}

/**
 * token 兜底：调用方可以显式传（便于测试注入），不传则内部重新解析。
 * 每次调用都重新读，所以换 key 后不用重启服务。
 */
function ensureToken(token) {
  const tk = token || resolveToken().token;
  if (!tk) throw new Error('未配置 Hyper3D API Key：请设置 HYPER3D_API_KEY 或写入 ~/.workbuddy/tokens/hyper3d');
  return tk;
}

/* ------------------------- multipart 构造 ------------------------- */

/**
 * 手工拼 multipart/form-data（不用第三方依赖）。
 * @param {{fields:Object, files:Array<{field,filename,contentType,content}>}} spec
 * @param {string} boundary
 */
export function buildMultipart(spec, boundary) {
  const { fields = {}, files = [] } = spec || {};
  const CRLF = '\r\n';
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
          `${String(value)}${CRLF}`,
        'utf8'
      )
    );
  }

  for (const f of files) {
    if (!f) continue;
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"${CRLF}` +
          `Content-Type: ${f.contentType || 'application/octet-stream'}${CRLF}${CRLF}`,
        'utf8'
      )
    );
    parts.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content || ''));
    parts.push(Buffer.from(CRLF, 'utf8'));
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  return Buffer.concat(parts);
}

/** 由 base64 首字节猜图片类型（文件名后缀只影响服务端解析，不影响内容） */
export function guessImageMeta(b64) {
  const s = String(b64 || '');
  if (s.startsWith('/9j/')) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (s.startsWith('iVBOR')) return { ext: 'png', contentType: 'image/png' };
  if (s.startsWith('UklGR')) return { ext: 'webp', contentType: 'image/webp' };
  return { ext: 'png', contentType: 'image/png' };
}

/* ------------------------- HTTP ------------------------- */

/** 发一个请求并解析 JSON；HTTP >= 400 或返回体非 JSON 均抛错（带 statusCode 供分类） */
function requestJson(pathname, { method = 'POST', headers = {}, body = null, timeout = 120000 } = {}) {
  const u = new URL(ENDPOINT + pathname);
  const mod = u.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            const e = new Error(`网关返回非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 300)}`);
            e.statusCode = res.statusCode;
            reject(e);
            return;
          }
          if (res.statusCode >= 400) {
            const e = new Error(
              `HTTP ${res.statusCode}: ${json.message || json.error || raw.slice(0, 200)}`
            );
            e.statusCode = res.statusCode;
            e.code = json.error || String(res.statusCode);
            reject(e);
            return;
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求网关超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postMultipart(pathname, { fields, files, token, timeout }) {
  const boundary = `----hyper3d${crypto.randomBytes(12).toString('hex')}`;
  const body = buildMultipart({ fields, files }, boundary);
  return requestJson(pathname, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    timeout,
  });
}

function postJson(pathname, obj, token, timeout = 60000) {
  return requestJson(pathname, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
    timeout,
  });
}

/* ------------------------- 1) Rodin 生成 ------------------------- */

/**
 * 提交 Rodin 图生 / 文生 3D。
 * @returns {Promise<{taskUuid:string, subscriptionKey:string, consumed:number, raw:Object}>}
 */
export async function submitRodin({
  imagesBase64 = [],
  prompt = '',
  tier = 'Gen-2.5-Medium',
  meshMode = 'Raw',
  quality = 'medium',
  geometryFileFormat = 'glb',
  material = 'PBR',
  token,
}) {
  const tk = ensureToken(token);
  const files = imagesBase64
    .filter(Boolean)
    .slice(0, 5) // 官方最多 5 张
    .map((b64, i) => {
      const m = guessImageMeta(b64);
      return {
        field: 'images',
        filename: `input-${i}.${m.ext}`,
        contentType: m.contentType,
        content: Buffer.from(String(b64), 'base64'),
      };
    });

  const fields = {
    tier,
    mesh_mode: meshMode,
    quality,
    geometry_file_format: geometryFileFormat,
    material,
  };
  // 图 + 文可共存；官方对二者无互斥约束，无图时 prompt 才必需
  if (prompt) fields.prompt = prompt;

  const res = await postMultipart('/rodin', { fields, files, token: tk, timeout: 120000 });
  const taskUuid = res.uuid;
  if (!taskUuid) {
    throw new Error(`提交失败，未拿到 uuid：${JSON.stringify(res).slice(0, 300)}`);
  }
  return {
    taskUuid,
    subscriptionKey: res.jobs?.subscription_key || '',
    consumed: res.consumed ?? null,
    raw: res,
  };
}

/* ------------------------- 2) BANG 拆解 ------------------------- */

/**
 * 提交 BANG 拆解：把模型拆成多个部件（车身 / 轮毂等）。
 *
 * assetId 与 modelBuffer **互斥**（官方约束），二选一：
 *   - assetId：Rodin 生成任务返回的顶层 uuid
 *   - modelBuffer：本地模型文件 Buffer（obj/glb/stl/fbx/usd/usda/usdz/usdc）
 *
 * 注意：prompt / image 必须与 model 配对使用，传 assetId 时不带这两个字段。
 *
 * @returns {Promise<{taskUuid:string, subscriptionKey:string, raw:Object}>}
 */
export async function submitBang({
  assetId = null,
  modelBuffer = null,
  modelName = 'model.glb',
  imageBase64 = null,
  prompt = '',
  strength = 5,
  geometryFileFormat = 'glb',
  material = 'PBR',
  resolution = 'Basic',
  token,
}) {
  const tk = ensureToken(token);
  // 调用方可能显式传 null，默认参数只对 undefined 生效，这里再兜一层
  const fname = modelName || 'model.glb';
  if (!assetId && !modelBuffer) {
    throw new Error('submitBang 需要 assetId 或 modelBuffer 之一');
  }
  if (assetId && modelBuffer) {
    throw new Error('asset_id 与 model 互斥，只能提供其一');
  }
  // strength 官方范围 2–12，越界钳制，避免云端直接拒收
  const s = Math.max(2, Math.min(12, Number(strength) || 5));

  const fields = {
    geometry_file_format: geometryFileFormat,
    material,
    resolution,
    strength: String(s),
  };
  const files = [];

  if (assetId) {
    fields.asset_id = assetId;
  } else {
    files.push({
      field: 'model',
      filename: fname,
      contentType: 'model/gltf-binary',
      content: modelBuffer,
    });
    // prompt / image 只在上传 model 时才有意义
    if (prompt) fields.prompt = prompt;
    if (imageBase64) {
      const m = guessImageMeta(imageBase64);
      files.push({
        field: 'image',
        filename: `ref.${m.ext}`,
        contentType: m.contentType,
        content: Buffer.from(String(imageBase64), 'base64'),
      });
    }
  }

  const res = await postMultipart('/bang', { fields, files, token: tk, timeout: 120000 });
  const taskUuid = res.uuid;
  if (!taskUuid) {
    throw new Error(`BANG 提交失败，未拿到 uuid：${JSON.stringify(res).slice(0, 300)}`);
  }
  return {
    taskUuid,
    subscriptionKey: res.jobs?.subscription_key || '',
    raw: res,
  };
}

/* ------------------------- 3) 状态 / 4) 下载 ------------------------- */

export const STATUS = {
  DONE: ['Done', 'DONE', 'done'],
  FAIL: ['Failed', 'FAILED', 'failed', 'Error', 'ERROR'],
  RUNNING: ['Waiting', 'Generating', 'Queued', 'Pending'],
};

/**
 * 轮询一次状态。
 * @returns {Promise<Array<{uuid:string,status:string}>>} 直接返回 jobs 数组，
 *   便于调用方 jobs.some(...) / jobs.every(...)；原始体挂在数组的 .raw 上备用。
 */
export async function queryStatus(subscriptionKey, token) {
  const tk = ensureToken(token);
  const res = await postJson('/status', { subscription_key: subscriptionKey }, tk, 60000);
  const jobs = Array.isArray(res.jobs) ? res.jobs : [];
  jobs.raw = res;
  return jobs;
}

export const allDone = (jobs) => jobs.length > 0 && jobs.every((j) => STATUS.DONE.includes(j.status));
export const anyFailed = (jobs) => jobs.some((j) => STATUS.FAIL.includes(j.status));

/** 把 URL 拉成本地 Buffer（跟随 3xx 重定向） */
export function downloadBuffer(url, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadBuffer(new URL(res.headers.location, u).toString(), timeoutMs));
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/**
 * 取回任务产物，并**立即下载到 Buffer**。
 * 官方 /download 返回的链接会过期，只存 URL 会在几小时后 403，必须落地。
 *
 * @returns {Promise<{files:Array<{name:string,url:string,buffer:Buffer}>, raw:Object}>}
 */
/** 从下载地址里抠出文件名（去掉签名 query），拿不到返回 null */
function nameFromUrl(url) {
  try {
    const u = new URL(String(url));
    const base = path.basename(u.pathname || '');
    return base && base !== '/' ? base : null;
  } catch {
    return null;
  }
}

export async function downloadTask(taskUuid, token, { defaultExt = 'glb' } = {}) {
  const tk = ensureToken(token);
  const res = await postJson('/download', { task_uuid: taskUuid }, tk, 60000);

  // 兼容多种返回形态：数组 / {files:[]} / {list:[]} / {urls:[]}
  const list = Array.isArray(res) ? res : res.files || res.list || res.urls || [];

  const candidates = list
    .map((it, i) => {
      const url = typeof it === 'string' ? it : it.url || it.download_url || it.link || it.downloadUrl;
      if (!url) return null;
      const given = typeof it === 'string' ? '' : it.name || it.filename || it.file_name || '';
      // 云端常只给 URL 不给文件名；且调用方靠扩展名筛 GLB，所以必须保证有后缀
      let name = given || nameFromUrl(url) || `part-${i}.${defaultExt}`;
      if (!path.extname(name)) name = `${name}.${defaultExt}`;
      return { url, name };
    })
    .filter(Boolean);

  const files = [];
  for (const c of candidates) {
    const buffer = await downloadBuffer(c.url);
    files.push({ name: c.name, url: c.url, buffer });
  }
  return { files, raw: res };
}

/* ------------------------- 错误分类 ------------------------- */

/** 命中即视为 key 失效/无效，前端据此走「换 key」引导 */
export const AUTH_CODES = new Set([
  'INVALID_REQUEST',
  'USER_NOT_FOUND',
  'GROUP_NOT_FOUND',
  'PERMISSION_DENIED',
  'NO_SUCH_TASK',
  'Unauthorized',
  'Forbidden',
]);

/**
 * 把异常归类，供 UI 分级引导。
 * @returns {'auth'|'quota'|'other'}
 */
export function classifyError(e) {
  const code = String(e?.code || '');
  if (AUTH_CODES.has(code)) return 'auth';
  const hay = `${code} ${e?.statusCode || ''} ${e?.message || ''}`;
  if (/401|403|unauthorized|forbidden|invalid.?key|permission.?denied|user.?not.?found/i.test(hay)) {
    return 'auth';
  }
  // 429 / 余额不足 / 订阅缺失 → 配额类，引导充值或等重置，不当成普通失败
  if (/429|rate.?limit|quota|limit.?exceeded|too.?many|insufficient.?balance|subscription.?required/i.test(hay)) {
    return 'quota';
  }
  return 'other';
}
