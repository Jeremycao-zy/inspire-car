/**
 * fal3d.mjs — fal.ai 上的 Hyper3D Rodin 客户端
 *
 * 为什么需要它：混元生成的精度不够高，且每天只有 5 次额度。
 * fal.ai 以按次计费（$0.4/次）提供同一个 Rodin 模型，无需订阅、无每日上限，
 * 画质与可控档位（Gen-2.5 Sketch→Extreme-High、4K HighPack）明显更强。
 *
 * 鉴权：Authorization: Key ${FAL_KEY}   （注意不是 Bearer）
 *
 * 异步三步：
 *   1) POST /fal-ai/hyper3d/rodin         → { request_id, status_url, response_url }
 *   2) GET  status_url                    → { status: IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED }
 *   3) GET  response_url                  → { model_mesh: { url }, textures: [...] }
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

/** 可用 FAL_ENDPOINT 覆盖，便于自测指向 mock */
export const ENDPOINT = process.env.FAL_ENDPOINT || 'https://queue.fal.run';
export const MODEL = process.env.FAL_RODIN_MODEL || 'fal-ai/hyper3d/rodin';

/** Key 来源：环境变量 FAL_KEY > ~/.workbuddy/tokens/fal */
export function resolveToken() {
  let token = '';
  if (process.env.FAL_KEY) token = process.env.FAL_KEY.trim();
  else {
    try {
      token = fs
        .readFileSync(path.join(process.env.HOME || '', '.workbuddy', 'tokens', 'fal'), 'utf8')
        .trim()
        .split(/\r?\n/)[0]
        .trim();
    } catch {
      /* 未配置 */
    }
  }
  return { token };
}

function ensureToken(token) {
  const tk = token || resolveToken().token;
  if (!tk) throw new Error('未配置 fal.ai Key：请设置 FAL_KEY 或写入 ~/.workbuddy/tokens/fal');
  return tk;
}

function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 120000 } = {}) {
  const u = new URL(urlStr);
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
            const e = new Error(`返回非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 300)}`);
            e.statusCode = res.statusCode;
            reject(e);
            return;
          }
          if (res.statusCode >= 400) {
            const e = new Error(
              `HTTP ${res.statusCode}: ${json.message || json.error || json.detail || raw.slice(0, 200)}`
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
    req.on('timeout', () => req.destroy(new Error('请求 fal 超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const authHeaders = (token, json = true) => ({
  Authorization: `Key ${token}`,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

/**
 * 提交生成任务。
 * @param {Object} o
 * @param {string[]=} o.imagesBase64 纯 base64 图片（内部转成 data URI 提交）
 * @param {string=} o.prompt
 * @param {string=} o.tier   Regular / Sketch / Gen-2.5-Medium / Gen-2.5-High ...
 * @param {string=} o.quality extra-low|low|medium|high
 * @param {string=} o.geometryFileFormat glb|obj|stl|fbx|usdz
 * @param {string=} o.material PBR|Shaded
 * @param {string[]=} o.addons 如 ['HighPack']（4K 贴图 + 高模，3 倍计费）
 */
export async function submitRodin({
  imagesBase64 = [],
  prompt = '',
  tier = 'Gen-2.5-High',
  quality = 'high',
  geometryFileFormat = 'glb',
  material = 'PBR',
  addons = [],
  token,
}) {
  const tk = ensureToken(token);

  // fal 的 rodin 收 URL 列表；data URI 由 fal 侧自动落到其存储，
  // 省去我们自己搭公网图床（本地项目没有可对外访问的地址）
  const input = {
    geometry_file_format: geometryFileFormat,
    material,
    tier,
    quality,
  };
  const urls = imagesBase64
    .filter(Boolean)
    .slice(0, 5)
    .map((b64) => `data:image/jpeg;base64,${String(b64)}`);
  if (urls.length) input.input_image_urls = urls.length === 1 ? urls[0] : urls;
  if (prompt) input.prompt = prompt;
  if (addons?.length) input.generation_adds_on = addons;

  const res = await request(`${ENDPOINT}/${MODEL}`, {
    method: 'POST',
    headers: authHeaders(tk),
    body: Buffer.from(JSON.stringify(input), 'utf8'),
    timeout: 120000,
  });

  const requestId = res.request_id;
  if (!requestId) throw new Error(`提交失败，未拿到 request_id：${JSON.stringify(res).slice(0, 300)}`);
  return {
    requestId,
    statusUrl: res.status_url || `${ENDPOINT}/${MODEL}/requests/${requestId}/status`,
    responseUrl: res.response_url || `${ENDPOINT}/${MODEL}/requests/${requestId}`,
    raw: res,
  };
}

export const STATUS = {
  DONE: ['COMPLETED'],
  FAIL: ['FAILED'],
  RUNNING: ['IN_QUEUE', 'IN_PROGRESS'],
};

/** 查一次状态，返回状态字符串 */
export async function queryStatus(statusUrl, token) {
  const tk = ensureToken(token);
  const res = await request(statusUrl, { method: 'GET', headers: authHeaders(tk, false), timeout: 60000 });
  return { status: res.status || 'UNKNOWN', raw: res };
}

/** 取最终结果：{ meshUrl, textures } */
export async function getResult(responseUrl, token) {
  const tk = ensureToken(token);
  const res = await request(responseUrl, { method: 'GET', headers: authHeaders(tk, false), timeout: 120000 });
  const meshUrl = res?.model_mesh?.url || res?.model_mesh?.uri || null;
  if (!meshUrl) throw new Error(`结果里没有 model_mesh.url：${JSON.stringify(res).slice(0, 300)}`);
  return { meshUrl, textures: res.textures || [], raw: res };
}

/** 把产物拉成本地 Buffer（跟随 3xx） */
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

export function classifyError(e) {
  const code = String(e?.code || '');
  const hay = `${code} ${e?.statusCode || ''} ${e?.message || ''}`;
  if (/401|403|unauthorized|forbidden|invalid.?key|permission/i.test(hay)) return 'auth';
  if (/429|rate.?limit|quota|limit.?exceeded|too.?many|insufficient|balance/i.test(hay)) return 'quota';
  return 'other';
}
