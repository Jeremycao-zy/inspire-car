/**
 * hunyuan3d.mjs — 腾讯混元 3D（HunyuanTo3D Pro）Node 客户端
 *
 * 接口契约（与官方 CLI 脚本完全一致）：
 *   provider      : hy-3d
 *   service       : ai3d
 *   version       : 2025-05-13
 *   region        : ap-guangzhou
 *   submit action : SubmitHunyuanTo3DProJob
 *   query  action : QueryHunyuanTo3DProJob
 *
 * 鉴权：TC3-HMAC-SHA256
 *   secretId  = `${provider}.${token}`     // token 为平台下发的 tempToken 或 JWT
 *   secretKey = 'codebuddy'                // 代理网关内置签名串，非用户密钥
 *
 * 为什么必须走服务端：
 *   1) 签名密钥不能出现在浏览器；
 *   2) copilot.tencent.com 不允许任意源跨域。
 * 因此浏览器只与本项目的 /api 通信，真实调用在 Node 侧完成。
 */

import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const PROVIDER = 'hy-3d';
const SERVICE = 'ai3d';
const VERSION = '2025-05-13';
const REGION = 'ap-guangzhou';
const SUBMIT_ACTION = 'SubmitHunyuanTo3DProJob';
const QUERY_ACTION = 'QueryHunyuanTo3DProJob';
const SIGNING_KEY = 'codebuddy';

/** 代理网关地址，可用 BUDDY_CLOUD_ENDPOINT 覆盖 */
export const ENDPOINT =
  process.env.BUDDY_CLOUD_ENDPOINT || 'https://copilot.tencent.com/agenttool/v1/tcproxy';

/* ------------------------- TC3 签名 ------------------------- */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

/** 生成 TC3-HMAC-SHA256 请求头 */
function signRequest({ secretId, secretKey, action, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const host = new URL(ENDPOINT).hostname;
  const contentType = 'application/json; charset=utf-8';

  // 1. 规范请求串
  const canonicalHeaders =
    `content-type:${contentType}\n` + `host:${host}\n` + `x-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(Buffer.from(payload, 'utf8')),
  ].join('\n');

  // 2. 待签串
  const algorithm = 'TC3-HMAC-SHA256';
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  // 3. 派生签名密钥
  const secretDate = hmac(Buffer.from(`TC3${secretKey}`, 'utf8'), date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');

  // 4. 签名
  const signature = crypto
    .createHmac('sha256', secretSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    Authorization: `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': VERSION,
    'X-TC-Region': REGION,
    'X-TC-Timestamp': String(timestamp),
  };
}

/* ------------------------- HTTP ------------------------- */

/** 发一个 POST JSON 请求，返回解析后的 Response 体 */
function postJson(bodyObj, action, token) {
  const payload = JSON.stringify(bodyObj);
  const headers = signRequest({
    secretId: `${PROVIDER}.${token}`,
    secretKey: SIGNING_KEY,
    action,
    payload,
    timestamp: Math.floor(Date.now() / 1000),
  });

  return new Promise((resolve, reject) => {
    const u = new URL(ENDPOINT);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers,
        timeout: 120000,
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
            reject(new Error(`网关返回非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 300)}`));
            return;
          }
          const inner = json.Response ?? json;
          if (inner?.Error) {
            const e = new Error(inner.Error.Message || '云端返回错误');
            e.code = inner.Error.Code;
            e.requestId = inner.RequestId;
            reject(e);
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${json.message || raw.slice(0, 200)}`));
            return;
          }
          resolve(inner);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求网关超时')));
    req.on('error', reject);
    req.write(Buffer.from(payload, 'utf8'));
    req.end();
  });
}

/* ------------------------- 对外 API ------------------------- */

/**
 * 提交图生 3D 任务。
 * @param {Object} args
 * @param {string[]} args.imagesBase64 图片 base64（纯数据，不含 data: 前缀）
 * @param {string=} args.prompt 文本描述（无图时走文生 3D）
 * @param {string=} args.multiViewJson MultiViewImages（需要公网 URL，见 README）
 * @param {string} args.token
 * @param {string=} args.model 默认 3.1
 * @param {number=} args.faceCount 目标面数
 * @param {boolean=} args.enablePbr
 * @returns {Promise<{jobId:string, raw:Object}>}
 */
export async function submitJob({
  imagesBase64 = [],
  prompt = '',
  multiViewJson = null,
  token,
  model = '3.1',
  faceCount = 150000,
  enablePbr = true,
  quality,
}) {
  // ResultFormat 必须是大写，云端只接受 [OBJ, GLB, STL, FBX, USDZ]
  const body = { Model: model, ResultFormat: 'GLB' };
  if (prompt) body.Prompt = prompt;
  if (imagesBase64.length) body.ImageBase64 = imagesBase64[0]; // 主视角走 base64
  if (multiViewJson) {
    try {
      body.MultiViewImages = JSON.parse(multiViewJson);
    } catch {
      /* 格式不合法则忽略，退化为单图 */
    }
  }
  if (enablePbr) body.EnablePBR = true;
  if (faceCount) body.FaceCount = faceCount;
  // 可选质量透传（字段名以实测为准，缺省忽略）
  if (quality != null && quality !== undefined) body.Quality = quality;

  const res = await postJson(body, SUBMIT_ACTION, token);
  const jobId = res.JobId;
  if (!jobId) throw new Error(`提交失败，未拿到 JobId：${JSON.stringify(res).slice(0, 300)}`);
  return { jobId, raw: res };
}

/**
 * 查询任务状态。
 * @returns {Promise<{status:string, files:Array<{type:string,url:string,preview?:string}>, raw:Object}>}
 */
export async function queryJob(jobId, token) {
  const res = await postJson({ JobId: jobId }, QUERY_ACTION, token);
  const status = res.Status || res.status || 'UNKNOWN';

  const files = [];
  const list = res.ResultFile3Ds || res.ResultFiles3D || res.ResultFile3D || [];
  for (const u of list) {
    const url = u.Url || u.url;
    if (!url) continue;
    files.push({
      type: (u.Type || u.type || 'glb').toLowerCase(),
      url,
      preview: u.PreviewImageUrl || u.preview_image_url || undefined,
    });
  }
  // 兼容只给 ResultUrl 的返回形态
  if (!files.length) {
    const ru = res.ResultUrl || res.ResultUrls;
    const first = Array.isArray(ru) ? ru[0] : ru;
    if (first) files.push({ type: 'glb', url: first });
  }
  return { status, files, raw: res };
}

export const STATUS = {
  DONE: ['DONE', 'SUCCESS', 'Success', 'success', 'done'],
  FAIL: ['FAIL', 'FAILED', 'Failed', 'failed', 'ERROR', 'Error'],
  RUNNING: ['RUNNING', 'Running', 'running', 'WAIT', 'Wait', 'wait', 'PENDING', 'SUBMITTED'],
};

/* ------------------------- 错误分类（供 LIVE 失败分级） ------------------------- */

/**
 * 凭证类错误码。命中即视为 token 失效/无效，前端据此走「换票」引导，
 * 而不是把它当成一次普通的生成失败。
 */
export const AUTH_CODES = new Set([
  'AuthFailure',
  'InvalidCredential',
  'TokenExpired',
  'AuthTokenExpired',
  'SignatureDoesNotMatch',
  'UnauthorizedOperation',
  'AccessDenied',
  'RequestLimitExceeded',
]);

/**
 * 把网关/HTTP 异常归类。
 * @param {Error} e
 * @returns {'auth'|'other'}
 */
export function classifyError(e) {
  const code = e?.code || '';
  if (AUTH_CODES.has(code)) return 'auth';
  const hay = `${code} ${e?.message || ''} ${e?.stack || ''}`;
  if (/401|403|unauthorized|forbidden|signaturedoesnotmatch|token\s?expired|credential/i.test(hay)) {
    return 'auth';
  }
  return 'other';
}

/** 下载远端资源到本地 Buffer */
export function download(url, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      u,
      { timeout: timeoutMs },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(download(new URL(res.headers.location, u).toString(), timeoutMs));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`下载失败 HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}
