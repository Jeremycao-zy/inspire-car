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
import { readFileSync } from 'node:fs';

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
/* ================================================================== */
/*  权威车型库（本地真实参数 JSON + 可选用户扩展库）                     */
/* ================================================================== */

/**
 * 匹配阈值：归一化车型名与库条目相似度 ≥ 此值才算命中。
 * 初值 0.85（见增量设计文档 §2.a.3），可调。
 */
const MATCH_THRESHOLD = 0.85;

/**
 * 品牌同义归一表：中英文品牌名统一映射到规范 token。
 * 用于跨中英文做模糊匹配（奔驰↔mercedes、宝马↔bmw …）。
 */
const BRAND_NORMALIZERS = [
  [/奔驰|mercedes[ -]?benz?/gi, 'mercedes'],
  [/宝马|b[mn]w/gi, 'bmw'],
  [/丰田|toyota/gi, 'toyota'],
  [/本田|honda/gi, 'honda'],
  [/保时捷|porsche/gi, 'porsche'],
  [/福特|ford/gi, 'ford'],
  [/特斯拉|tesla/gi, 'tesla'],
  [/路虎|land[ -]?rover/gi, 'landrover'],
  [/大众|vw|volkswagen/gi, 'vw'],
  [/奥迪|audi/gi, 'audi'],
];

/**
 * 归一车型名：小写 → 品牌同义归一 → 去空格与标点，只保留字母数字。
 * 这样「奔驰SL350」与「奔驰 SL 350」「Mercedes SL350」都归一到同一串，便于模糊匹配。
 * @param {string} s
 * @returns {string}
 */
function normalizeName(s) {
  if (!s) return '';
  let t = String(s).toLowerCase();
  for (const [re, token] of BRAND_NORMALIZERS) t = t.replace(re, token);
  return t.replace(/[^a-z0-9]/g, '');
}

/** 读取并合并种子库 + 用户扩展库（用户库按 key 覆盖种子）。结果缓存复用。 */
let _mergedCarDb = null;
function loadOfficialDb() {
  if (_mergedCarDb) return _mergedCarDb;
  const read = (rel) => {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
    } catch {
      return null;
    }
  };
  const seed = read('./carSpecs.db.json');
  const user = read('./carSpecs.user.db.json');
  const byKey = new Map();
  for (const c of seed?.cars || []) byKey.set(c.key, c);
  for (const c of user?.cars || []) byKey.set(c.key, c); // user 优先覆盖
  _mergedCarDb = { version: seed?.version ?? 1, cars: [...byKey.values()] };
  return _mergedCarDb;
}

/**
 * 在本地车型库里模糊匹配车型名。
 * 命中规则（见增量设计文档 §2.a.3）：
 *   - 归一后查询 == 某候选（key / 别名 / 品牌+车型）→ 精确命中，score 1.0
 *   - 否则若「品牌+车型」归一串是查询的子串 → 核心车型命中，score 0.85
 * 返回 { car, score } 或 null（未命中）。
 * @param {string} query
 * @returns {{car:Object, score:number}|null}
 */
function lookupOfficialDb(query) {
  const q = normalizeName(query);
  if (!q) return null;
  const db = loadOfficialDb();
  let best = null;
  for (const car of db.cars) {
    const candidates = [
      normalizeName(car.key),
      normalizeName(`${car.brand}${car.model}`),
      ...(car.aliases || []).map(normalizeName),
    ];
    let score = 0;
    if (candidates.some((c) => c && c === q)) {
      score = 1.0; // 精确 / 别名命中
    } else {
      const brandModel = normalizeName(`${car.brand}${car.model}`);
      if (brandModel && q.includes(brandModel)) score = MATCH_THRESHOLD; // 核心车型命中
    }
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { car, score };
    }
  }
  return best;
}

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

  // ① DB 优先：命中且核心尺寸（长/宽/高/轴距）齐全 → 直接返回验证过的官方库数据
  //    （高可信、零额度，不消耗大模型调用）。
  const hit = lookupOfficialDb(name);
  const ESSENTIAL = ['length', 'width', 'height', 'wheelbase'];
  if (hit && ESSENTIAL.every((k) => Number.isFinite(hit.car.specs?.[k]))) {
    const sp = hit.car.specs;
    return {
      available: true,
      ...sp,
      // 验证过的参数 → 固定高可信度（区别于 LLM 的字段完整度）
      source: 'official-db',
      confidence: 0.95,
      matchedKey: hit.car.key,
      query: name,
    };
  }

  // ② 退回现有 LLM（保留 postChat / extractJson / sanitizeSpecs / RANGE 校验）
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
    // 核心尺寸（长/宽/高/轴距）缺任何一项就认为这次查询不可用，避免用残缺数据建模。
    // ⚠️ height 必须纳入核心：图生 3D 模型普遍偏矮，normalizeCar 只在拿到真实车高时
    // 才做非均匀校正（拉高第三轴）；height 缺失 → 车高保持模型原始偏矮值 → 表现"矮胖"。
    const essential = ['length', 'width', 'height', 'wheelbase'];
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
      // 来源标记为大模型估算（历史值『模型参数库（xxx）』视作同义）
      source: 'model-llm',
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
