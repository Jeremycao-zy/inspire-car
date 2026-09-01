/**
 * specs.js — 按车型名查询真实车身参数
 *
 * 目的：让整个 APP 的比例建立在**真车数据**上，而不是拍脑袋的默认值。
 * 识别出的车型 → 查到真实长宽高/轴距/轮距 → 用于归一建模与四轮定位，
 * 于是后续所有调节（ET、J 值、倾角、轮距、悬挂）都是按真车尺度在算。
 *
 * 数据来源：复用视觉识别那套 Key / 端点（resolveChatConfig），
 * 让大模型作为"参数库"返回结构化 JSON。
 * 这是当前**最简单、无需新增 Key、无需爬虫**的取数方式；
 * 若日后要接权威数据源（汽车之家/厂商公开参数），只需替换 querySpecsFromLLM 内部实现，
 * 对外的 carSpecs() 契约保持不变。
 *
 * ⚠️ 大模型的参数属于"记忆值"，可能与具体年款/配置有偏差。
 *    因此下面对所有数值做了**合理性区间校验**（越界即丢弃），
 *    并在返回里标注 source 与 confidence，前端应当明示来源、允许用户手改。
 */

import { resolveChatConfig } from './vision.mjs';

/** 真车参数的合理区间。长度单位毫米（角度单位度）。越界视为模型幻觉，直接丢弃该字段。 */
const RANGE = {
  length: [3200, 6200], // 车长：小型车 ~ 全尺寸 SUV/皮卡
  width: [1450, 2200], // 车宽（不含后视镜）
  height: [1250, 2200], // 车高：跑车 ~ 轻客
  wheelbase: [2000, 4000], // 轴距
  trackFront: [1200, 1900], // 前轮距
  trackRear: [1200, 1900], // 后轮距
  groundClearance: [100, 400], // 离地间隙 mm
  approachAngle: [5, 45], // 接近角 °
  departureAngle: [5, 45], // 离去角 °
  rimInch: [13, 24], // 轮毂直径（英寸）
  tireWidth: [125, 405], // 胎宽 mm
  aspect: [25, 85], // 扁平比 %
};

const SYSTEM_PROMPT = `你是一个精确的汽车参数数据库。用户给出车型名称，你返回该车型的官方车身参数。
只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块、不要额外文字。
所有长度单位统一为**毫米**（轮毂直径用英寸，胎宽用毫米，扁平比用百分数）。
如果某个字段确实无法确定，填 null，不要编造。`;

function buildPrompt(fullName, year) {
  const y = year ? `（${year}）` : '';
  return `请给出「${fullName}」${y}的官方车身参数，JSON 格式：
{
  "length": 车长mm,
  "width": 车宽mm,
  "height": 车高mm,
  "wheelbase": 轴距mm,
  "trackFront": 前轮距mm,
  "trackRear": 后轮距mm,
  "groundClearance": 离地间隙mm,
  "approachAngle": 接近角°,
  "departureAngle": 离去角°,
  "rimInch": 原厂轮毂直径英寸,
  "tireWidth": 原厂轮胎宽度mm,
  "aspect": 原厂轮胎扁平比
}
若该车型有多个年款/配置，取最常见版本的数值。`;
}

/** 从模型输出里抠出 JSON（容忍 ```json 代码块与前后废话） */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
}

/** 逐字段做区间校验，丢弃越界值，返回 { 值, 被丢弃的字段 } */
export function sanitizeSpecs(raw) {
  const out = {};
  const dropped = [];
  for (const [k, [min, max]] of Object.entries(RANGE)) {
    const v = Number(raw?.[k]);
    if (!Number.isFinite(v)) {
      out[k] = null;
      continue;
    }
    if (v < min || v > max) {
      out[k] = null;
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  return { specs: out, dropped };
}

async function postChat({ endpoint, apiKey, payload, timeout = 60000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const e = new Error(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查车型真实参数。
 *
 * @param {string} fullName 车型全名，如 "福特Escort"
 * @param {{year?:string}} [opts]
 * @returns {Promise<{
 *   available:boolean, reason?:string, detail?:string,
 *   length:number|null, width:number|null, height:number|null,
 *   wheelbase:number|null, trackFront:number|null, trackRear:number|null,
 *   groundClearance:number|null, approachAngle:number|null, departureAngle:number|null,
 *   rimInch:number|null, tireWidth:number|null, aspect:number|null,
 *   source:string, confidence:number, dropped?:string[], query?:string
 * }>}
 */
export async function carSpecs(fullName, { year } = {}) {
  const name = String(fullName || '').trim();
  if (!name) return { available: false, reason: 'error', detail: '缺少车型名' };

  const cfg = resolveChatConfig();
  if (!cfg) return { available: false, reason: 'no-key' };

  const payload = JSON.stringify({
    model: cfg.model,
    // Qwen3 关掉思考模式，避免推理过程污染 JSON 输出
    ...(cfg.name === 'qwen' ? { enable_thinking: false } : {}),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(name, year) },
    ],
  });

  try {
    const body = await postChat({ endpoint: cfg.endpoint, apiKey: cfg.key, payload });
    const content = body?.choices?.[0]?.message?.content || '';
    const raw = extractJson(content);
    if (!raw) {
      return { available: false, reason: 'error', detail: `未能解析参数 JSON：${content.slice(0, 200)}` };
    }

    const { specs, dropped } = sanitizeSpecs(raw);
    // 核心尺寸（长/宽/轴距）缺任何一项就认为这次查询不可用，避免用残缺数据建模
    const essential = ['length', 'width', 'wheelbase'];
    const missing = essential.filter((k) => specs[k] == null);
    if (missing.length) {
      return {
        available: false,
        reason: 'error',
        detail: `缺少核心尺寸：${missing.join('/')}`,
        dropped,
      };
    }

    return {
      available: true,
      ...specs,
      source: `模型参数库（${cfg.name}）`,
      // 字段越全越可信
      confidence: Math.round(
        (Object.values(specs).filter((v) => v != null).length / Object.keys(RANGE).length) * 100
      ) / 100,
      dropped,
      query: name,
    };
  } catch (e) {
    const isAuth = e.status === 401 || e.status === 403 || /401|403|api.?key/i.test(e.message || '');
    return { available: false, reason: isAuth ? 'auth' : 'error', detail: e.message };
  }
}
