/**
 * vision.mjs — 车型识别（视觉大模型）抽象层
 *
 * 重要前提：本项目的零账号内置 token（tcproxy / hy-3d）只覆盖图生 3D，
 * 不覆盖任何视觉服务。已实测：用同一 token 走 provider=hunyuan 会返回
 *   HTTP 401: unknown provider: hunyuan
 * 所以车型识别需要一个独立的「视觉模型 API key」。
 *
 * 多供应商可插拔：
 *   - qwen    ：阿里通义千问视觉 Qwen3-VL（默认首选，中文车系最强）
 *               ⚠️ 旧模型 qwen2.5-vl-* 已于 2026-05-13 在百炼下线，勿再用
 *   - hunyuan ：腾讯混元视觉，OpenAI 兼容端点，有免费额度
 *   - openai  ：任何 OpenAI 兼容端点（OpenAI / DeepSeek / 智谱 GLM 等）
 *
 * 2026-08-30 阿里云 DashScope 控制台迁移到百炼（bailian.console.aliyun.com）：
 *   - 旧端点 https://dashscope.aliyuncs.com/compatible-mode/v1 仍可正常使用
 *   - 新百炼业务空间域名（推荐/高性能）：
 *       https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1
 *     地域可选 cn-beijing / ap-southeast-1 / ap-northeast-1 / us-east-1
 *   - 需要同时提供 WorkspaceId + 该地域的 API Key
 *
 * 自动探测逻辑（无需记环境变量）：
 *   1) 显式 VISION_API_KEY 存在 → 用 VISION_PROVIDER（默认 openai 兼容端点）
 *   2) 按优先级 qwen > hunyuan > openai 探测各供应商的 key（文件 or 环境变量）
 *   3) 探测到哪个就用哪个；都没 → no-key，前端走手动命名兜底
 *
 * key 读取位置（每个供应商独立）：
 *   qwen    ：文件 ~/.workbuddy/tokens/qwen-vision（旧 key）
 *                    ~/.workbuddy/tokens/bailian-vision（新百炼 key）
 *             或环境变量 DASHSCOPE_API_KEY / QWEN_API_KEY / QWEN_VL_API_KEY
 *                          BAILIAN_API_KEY
 *   hunyuan ：文件 ~/.workbuddy/tokens/hunyuan-vision
 *             或环境变量 HUNYUAN_VISION_KEY
 *   openai  ：文件 ~/.workbuddy/tokens/vision（或 openai-vision）
 *             或环境变量 VISION_API_KEY / OPENAI_API_KEY
 *
 * 百炼业务空间（可选，切换高性能新域名）：
 *   文件 ~/.workbuddy/tokens/bailian-workspace-id
 *   或环境变量 WORKSPACE_ID / BAILIAN_WORKSPACE_ID
 *   地域 ~/.workbuddy/tokens/bailian-region（默认 cn-beijing）
 *   或环境变量 BAILIAN_REGION
 *
 * 代理：自动读取 HTTPS_PROXY / HTTP_PROXY 环境变量。有代理（如沙箱/公司网）
 *      时通过 CONNECT 隧道转发 https 请求；无代理时直连。对用户本机零影响。
 */

import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  '';
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

/* ------------------------- 供应商配置 ------------------------- */

const QWEN_LEGACY_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const QWEN_WORKSPACE_ENDPOINT_TEMPLATE = 'https://{workspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEFAULT_BAILIAN_REGION = 'cn-beijing';

const PROVIDERS = {
  qwen: {
    // 默认模型：Qwen3-VL-Plus（当前在线，中文车系识别强）
    // 更快更便宜可覆盖为 qwen3-vl-flash
    model: 'qwen3-vl-plus',
    keyFiles: ['qwen-vision', 'bailian-vision'],
    envKeys: ['BAILIAN_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'QWEN_VL_API_KEY'],
    legacyEndpoint: QWEN_LEGACY_ENDPOINT,
    workspaceEndpointTemplate: QWEN_WORKSPACE_ENDPOINT_TEMPLATE,
  },
  hunyuan: {
    endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    model: 'hunyuan-vision',
    keyFiles: ['hunyuan-vision'],
    envKeys: ['HUNYUAN_VISION_KEY'],
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyFiles: ['vision', 'openai-vision'],
    envKeys: ['VISION_API_KEY', 'OPENAI_API_KEY'],
  },
};

/* ------------------------- 工具 ------------------------- */

function readKeyFile(name) {
  try {
    return fs
      .readFileSync(path.join(homedir(), '.workbuddy', 'tokens', name), 'utf8')
      .split('\n')[0]
      .trim();
  } catch {
    return '';
  }
}

function findKeyFor(provider) {
  const p = PROVIDERS[provider];
  const cands = [...p.envKeys.map((e) => process.env[e] || ''), ...p.keyFiles.map(readKeyFile)];
  for (const c of cands) if (c && c.trim()) return c.trim();
  return null;
}

function getWorkspaceId() {
  return (
    process.env.WORKSPACE_ID ||
    process.env.BAILIAN_WORKSPACE_ID ||
    readKeyFile('bailian-workspace-id') ||
    ''
  ).trim();
}

function getBailianRegion() {
  return (
    process.env.BAILIAN_REGION ||
    readKeyFile('bailian-region') ||
    DEFAULT_BAILIAN_REGION
  ).trim();
}

/**
 * 返回 { name, key } 或 null。
 * 自动探测优先级：qwen > hunyuan > openai（被用户选中的 qwen 排第一）。
 */
export function getVisionKey() {
  // 显式 VISION_API_KEY 优先（可配 VISION_PROVIDER，否则按 openai 兼容端点）
  if (process.env.VISION_API_KEY) {
    const name = process.env.VISION_PROVIDER || 'openai';
    return { name, key: process.env.VISION_API_KEY.trim() };
  }
  for (const name of ['qwen', 'hunyuan', 'openai']) {
    const k = findKeyFor(name);
    if (k) return { name, key: k };
  }
  return null;
}

function buildQwenEndpoint(workspaceId, region) {
  if (!workspaceId || !region) return QWEN_LEGACY_ENDPOINT;
  return QWEN_WORKSPACE_ENDPOINT_TEMPLATE
    .replace('{workspaceId}', workspaceId)
    .replace('{region}', region);
}

function resolveProvider(name) {
  const base = PROVIDERS[name] || PROVIDERS.qwen;

  // qwen 特殊处理：优先使用百炼业务空间域名（高性能），否则回退旧端点
  if (name === 'qwen') {
    const workspaceId = getWorkspaceId();
    const region = getBailianRegion();
    const endpoint =
      process.env.VISION_ENDPOINT ||
      (workspaceId ? buildQwenEndpoint(workspaceId, region) : base.legacyEndpoint);
    return {
      name,
      endpoint,
      model: process.env.VISION_MODEL || base.model,
      workspaceId: workspaceId || undefined,
      region: workspaceId ? region : undefined,
    };
  }

  return {
    name,
    endpoint: process.env.VISION_ENDPOINT || base.endpoint,
    model: process.env.VISION_MODEL || base.model,
  };
}

/** 对外暴露当前视觉识别配置状态（不含 key） */
export function getVisionStatus() {
  const vk = getVisionKey();
  if (!vk) {
    return { available: false, reason: 'no-key', provider: null, endpoint: null, model: null };
  }
  const { name } = vk;
  const { endpoint, model, workspaceId, region } = resolveProvider(name);
  return {
    available: true,
    provider: name,
    endpoint,
    model,
    workspaceId,
    region,
    hint:
      name === 'qwen'
        ? workspaceId
          ? '使用阿里云百炼业务空间域名（高性能）'
          : '使用旧 DashScope 兼容端点（仍可正常使用）'
        : undefined,
  };
}

/* ------------------------- 提示词 ------------------------- */

const SYSTEM_PROMPT = `你是一名资深汽车鉴定师。请仔细辨识用户上传的图片，识别其中车辆。
要求：
1. 只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块标记。
2. 字段说明：
   - brand：品牌中文名（如 小米、奔驰、宝马）
   - model：车型系列（如 SU7、SL、3系）
   - year：年款或上市年份（无法判断留空字符串）
   - trim：配置/版本（如 赛道版、Max、Pro、标准版；无法判断留空字符串）
   - fullName：一个干净、适合作为「任务名称」的中文全称，格式「品牌+车型+（年款）+（版本）」，例如「小米SU7赛道版」「奔驰SL 2005」
   - confidence：0~1 之间的识别把握度（小数）
3. 若图片里没有车或无法识别，brand 与 model 留空字符串，confidence 给 0。`;

/* ------------------------- 解析 ------------------------- */

function parseCar(text) {
  const t = (text || '').trim();
  if (!t) return { brand: '', model: '', year: '', trim: '', fullName: '', confidence: 0, raw: '' };
  let obj = null;
  try {
    obj = JSON.parse(t);
  } catch {
    /* 继续尝试抠 */
  }
  if (!obj) {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        obj = JSON.parse(t.slice(s, e + 1));
      } catch {
        obj = null;
      }
    }
  }
  if (!obj) {
    return { brand: '', model: '', year: '', trim: '', fullName: t.slice(0, 60), confidence: 0, raw: t };
  }
  const brand = String(obj.brand ?? '').trim();
  const model = String(obj.model ?? '').trim();
  const year = String(obj.year ?? '').trim();
  const trim = String(obj.trim ?? '').trim();
  const fullName =
    String(obj.fullName ?? '').trim() || [brand, model, year, trim].filter(Boolean).join(' ');
  const confidence = Number(obj.confidence ?? 0);
  return {
    brand,
    model,
    year,
    trim,
    fullName,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    raw: t,
  };
}

/* ------------------------- HTTP ------------------------- */

function postJson({ endpoint, apiKey, payload }) {
  const u = new URL(endpoint);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers,
    timeout: 120000,
  };
  // 有代理且目标是 https → 走 CONNECT 隧道（沙箱/公司网）；无代理 → 直连
  if (isHttps && proxyAgent) options.agent = proxyAgent;

  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          reject(new Error(`视觉接口返回非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 200)}`));
          return;
        }
        if (json.error) {
          const e = new Error(json.error.message || '视觉接口错误');
          e.status = res.statusCode;
          reject(e);
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('视觉接口超时')));
    req.on('error', reject);
    req.write(Buffer.from(payload, 'utf8'));
    req.end();
  });
}

/** 调用视觉模型识别一张车图（dataUrl 为完整 data:...;base64,...） */
export async function recognizeCar({ dataUrl, apiKey, endpoint, model, enableThinking }) {
  const payload = JSON.stringify({
    model,
    // 仅 Qwen3 系列需要，关掉思考模式避免污染 JSON 输出；其它供应商忽略此字段
    ...(enableThinking !== undefined ? { enable_thinking: enableThinking } : {}),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请识别这张图片中的车型。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  const body = await postJson({ endpoint, apiKey, payload });
  const content = body?.choices?.[0]?.message?.content || '';
  return parseCar(content);
}

/**
 * 对外：识别一张图，统一返回结构。
 *   { available:true, provider, brand, model, year, trim, fullName, confidence, raw }
 *   { available:false, reason:'no-key' }      未配置 key
 *   { available:false, reason:'auth', detail } key 失效/无权限
 *   { available:false, reason:'error', detail }其它错误
 */
export async function recognize({ dataUrl }) {
  const vk = getVisionKey();
  if (!vk) return { available: false, reason: 'no-key' };
  const { name, key } = vk;
  const { endpoint, model } = resolveProvider(name);
  try {
    const r = await recognizeCar({
      dataUrl,
      apiKey: key,
      endpoint,
      model,
      enableThinking: name === 'qwen' ? false : undefined,
    });
    return { available: true, provider: name, ...r };
  } catch (e) {
    const isAuth =
      e.status === 401 ||
      e.status === 403 ||
      /401|403|unauthorized|invalid|forbidden|api.?key|authentication/i.test(e.message || '');
    return { available: false, reason: isAuth ? 'auth' : 'error', detail: e.message };
  }
}

/**
 * 对外暴露"可直接发起 chat 请求"的完整配置，供其它模块（如 server/specs.js）
 * 复用同一套 Key / 端点 / 模型，避免各模块重复实现凭证解析。
 *
 * @returns {{name:string, key:string, endpoint:string, model:string}|null}
 */
export function resolveChatConfig() {
  const vk = getVisionKey();
  if (!vk) return null;
  const { endpoint, model } = resolveProvider(vk.name);
  return { name: vk.name, key: vk.key, endpoint, model };
}
