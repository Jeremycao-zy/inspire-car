/**
 * chat.mjs —「灵感改装 AI 改装助手」对话后端
 *
 * OpenAI 兼容的 /api/chat 代理：前端点阵球对话面板调用，后端把请求转发给
 * 真实大模型（默认腾讯混元/通义千问，按现有 vision.mjs 同款 key 探测逻辑）。
 *
 * 设计要点：
 *   · key 探测优先级 qwen > hunyuan > openai（与 vision.mjs 一致），无需记环境变量；
 *     本机已缓存的 ~/.workbuddy/tokens/qwen-vision 可直接驱动文本对话（qwen-plus）。
 *   · 支持流式（SSE，默认）与非流式（JSON）两种返回，前端按 content-type 自适应。
 *   · 没配 key → 不报错，返回一段友好兜底文案，前端照常显示（绝不白屏）。
 *   · 人设：改装助手，中文，聚焦轮毂/姿态/车漆/车型建议；用户在消息里带上当前
 *     车型/方案时会更有针对性。
 *
 * 环境变量（均可选，不配也能跑，只是走兜底文案）：
 *   CHAT_API_KEY   通用 OpenAI 兼容 key（配合 CHAT_PROVIDER，默认 openai 端点）
 *   CHAT_PROVIDER  qwen | hunyuan | openai（CHAT_API_KEY 存在时指定用哪个端点）
 *   其余同 vision.mjs：BAILIAN_API_KEY / DASHSCOPE_API_KEY / QWEN_API_KEY /
 *                      HUNYUAN_VISION_KEY / OPENAI_API_KEY 等
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  '';

/* ------------------------- 供应商配置（文本对话） ------------------------- */

const QWEN_LEGACY_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const QWEN_WORKSPACE_ENDPOINT_TEMPLATE =
  'https://{workspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEFAULT_BAILIAN_REGION = 'cn-beijing';

const PROVIDERS = {
  qwen: {
    model: 'qwen-plus',
    keyFiles: ['qwen-vision', 'bailian-vision'],
    envKeys: ['BAILIAN_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'QWEN_VL_API_KEY'],
    legacyEndpoint: QWEN_LEGACY_ENDPOINT,
    workspaceEndpointTemplate: QWEN_WORKSPACE_ENDPOINT_TEMPLATE,
  },
  hunyuan: {
    endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    model: 'hunyuan-turbo',
    keyFiles: ['hunyuan-vision'],
    envKeys: ['HUNYUAN_VISION_KEY'],
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyFiles: ['vision', 'openai-vision'],
    envKeys: ['OPENAI_API_KEY', 'VISION_API_KEY'],
  },
};

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
  const cands = [
    ...p.envKeys.map((e) => process.env[e] || ''),
    ...p.keyFiles.map(readKeyFile),
  ];
  for (const c of cands) if (c && c.trim()) return c.trim();
  return null;
}

function getWorkspaceId() {
  return (process.env.WORKSPACE_ID || process.env.BAILIAN_WORKSPACE_ID || readKeyFile('bailian-workspace-id') || '').trim();
}
function getBailianRegion() {
  return (process.env.BAILIAN_REGION || readKeyFile('bailian-region') || DEFAULT_BAILIAN_REGION).trim();
}

function qwenEndpoint() {
  const ws = getWorkspaceId();
  const region = getBailianRegion();
  if (!ws || !region) return QWEN_LEGACY_ENDPOINT;
  return QWEN_WORKSPACE_ENDPOINT_TEMPLATE.replace('{workspaceId}', ws).replace('{region}', region);
}

/** 返回 { name, key, endpoint, model } 或 null（无 key） */
export function getChatKey() {
  // 显式 CHAT_API_KEY 优先：配合 CHAT_PROVIDER 选端点（默认 openai 兼容）
  if (process.env.CHAT_API_KEY) {
    const name = (process.env.CHAT_PROVIDER || 'openai').trim();
    const p = PROVIDERS[name] || PROVIDERS.openai;
    return {
      name,
      key: process.env.CHAT_API_KEY.trim(),
      endpoint: p.endpoint || qwenEndpoint(),
      model: p.model,
    };
  }
  for (const name of ['qwen', 'hunyuan', 'openai']) {
    const k = findKeyFor(name);
    if (k) {
      const p = PROVIDERS[name];
      return {
        name,
        key: k,
        endpoint: name === 'qwen' ? qwenEndpoint() : p.endpoint,
        model: p.model,
      };
    }
  }
  return null;
}

const SYSTEM_PROMPT = `你是「灵感改装 / Inspire Car」的 AI 改装助手，服务对汽车外观改装（轮毂、轮胎、姿态、车漆、包围）感兴趣的用户。
请用简体中文、友好且专业的语气回答，控制在 3 句以内、给出可操作的建议。
可以主动结合用户的车型、年款、预算给方案；不确定时礼貌追问，不要编造具体参数。
如果用户提到当前车辆或方案，优先基于已知信息给建议。`;

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

const FALLBACK =
  '当前还没配置 AI 对话密钥，我先给个通用建议：换轮毂优先考虑 ET 值与轮拱间隙，姿态 lowers 建议 1–2 指；想更稳可以发我你的车型，我帮你细化方案。';

/**
 * POST /api/chat
 * body: { messages: [{role:'user'|'assistant', content:string}], stream?:boolean }
 * 返回：stream=true → text/event-stream（OpenAI 格式 data: {...}）；否则 JSON {reply, model}
 */
export async function handleChat(req, res) {
  // 客户端中途断开（关面板 / 切走 / 网络抖动）→ 中止上游拉流，避免写到已死 socket
  // 触发未捕获异常把整个 API 进程搞崩。dev.mjs 在 API 子进程退出时会连前端一起杀掉，
  // 所以这里必须自己兜底，绝不能让一次异常请求拖垮整个本地环境 / 线上实例。
  const ac = new AbortController();
  let clientGone = false;
  const onClientGone = () => {
    clientGone = true;
    ac.abort();
  };
  // 关键：必须用 res 的 close（且响应未正常结束）判断客户端断开，
  // 不能用 req 的 close —— req 在请求体读完时就已 close，会误杀每一条正常请求。
  res.on('close', () => {
    if (!res.writableEnded) onClientGone();
  });
  res.on('error', onClientGone);

  const body = await readJsonBody(req);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const stream = body?.stream !== false; // 默认流式
  const ak = getChatKey();

  if (!ak) {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FALLBACK } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      sendJson(res, 200, { reply: FALLBACK, model: null });
    }
    return;
  }

  const payload = {
    model: ak.model,
    stream,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
  };
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ak.key}`,
  };

  try {
    const r = await fetch(ak.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
      // 走系统代理（沙箱/公司网）时经 CONNECT 隧道；本机无代理直连
      ...(PROXY_URL ? { dispatcher: undefined } : {}),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ error: `${r.status} ${r.statusText} ${txt.slice(0, 200)}` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        sendJson(res, 200, { reply: `对话服务暂不可用（${r.status}）。${FALLBACK}`, model: ak.model });
      }
      return;
    }

    if (stream && r.body) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      try {
        for await (const chunk of r.body) {
          if (clientGone) break; // 客户端已断开，别再往死 socket 写
          res.write(chunk);
        }
        if (!clientGone) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch (e) {
        if (!clientGone) {
          res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } else {
      const j = await r.json().catch(() => ({}));
      const reply = j.choices?.[0]?.message?.content || '';
      sendJson(res, 200, { reply, model: ak.model });
    }
  } catch (e) {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      sendJson(res, 200, { reply: `对话出错了：${e.message}。${FALLBACK}`, model: ak.model });
    }
  }
}
