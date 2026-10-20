/**
 * engineProbe.mjs — 引擎凭证真实性探测
 *
 * 背景（一个真实的坑）：
 *   /api/health 原来的判断是 `token ? 'live' : 'demo'` —— 只要令牌字符串非空
 *   就报 live，**不校验云端是否接受**。结果一个 2026-08-30 就过期的平台令牌，
 *   在健康检查里连续 7 周显示 live，而云端实际返回
 *   `HTTP 401: {"error":"invalid temp key"}`。用户被这个假 state 误导，
 *   以为混元引擎正常，实际早已不可用（靠降级链切到 Hyper3D 才没被发现）。
 *
 * 本模块用各引擎自带的客户端发一个**无害请求**来验证凭证是否真被接受。
 *
 * 无害性保证（三条都很重要）：
 *   1. 只调查询类接口，且用随机生成的假 ID —— 不创建任务、不消耗额度、不改状态
 *   2. 每个探测独立超时（默认 5s），任一挂起不影响其他引擎，更不影响 /api/health
 *   3. 任何异常都在内部消化成三态结果，绝不抛到外层
 *
 * 三态语义（刻意不用布尔，因为"探不出来"和"探出是坏的"必须区分）：
 *   true  云端接受了凭证（含"额度用完"——那反而证明凭证有效）
 *   false 云端明确拒绝凭证（401/403/invalid key）
 *   null  无法判定（网络错误、超时、或该引擎没有可靠的无害探测端点）
 */
import * as hy3d from './hunyuan3d.mjs';
import * as hyper3d from './hyper3d.mjs';
import * as fal from './fal3d.mjs';

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000; // 健康检查可能被频繁点，加个短缓存避免反复打云端

/** 探测结果缓存：{ at, value } */
let cache = { at: 0, value: null };

function rand() {
  return Math.random().toString(36).slice(2, 10);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`probe timeout after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * 探测单个引擎。
 * @param {string} token 凭证
 * @param {(t:string)=>Promise<any>} call 用该凭证发一次无害请求
 * @param {(e:any)=>'auth'|'quota'|'other'} classify 该引擎的错误分类器
 * @returns {Promise<{verified: boolean|null, reason: string}>}
 */
async function probeOne(token, call, classify) {
  if (!token) return { verified: null, reason: 'no-token' };
  try {
    await withTimeout(call(token), PROBE_TIMEOUT_MS);
    // 请求成功返回（哪怕内容是"任务不存在"）—— 说明凭证被云端接受
    return { verified: true, reason: 'credential-accepted' };
  } catch (e) {
    let kind = 'other';
    try {
      kind = classify(e) || 'other';
    } catch {
      /* 分类器自身出错按 other 处理 */
    }
    if (kind === 'auth') {
      return { verified: false, reason: 'auth-rejected' };
    }
    if (kind === 'quota') {
      // 额度/限流错误恰恰证明凭证是有效的，只是没钱了或太快了
      return { verified: true, reason: 'credential-ok-quota-exhausted' };
    }
    const msg = String(e?.message || e).slice(0, 120);
    return { verified: null, reason: `indeterminate: ${msg}` };
  }
}

/** 各引擎的无害探测请求。全部只读、用假 ID、不消耗额度。 */
const PROBES = {
  // 用一个不存在的 JobId 查询：凭证无效 → 401；有效 → 返回"任务不存在"类内容
  hunyuan: {
    call: (t) => hy3d.queryJob(`health-probe-${rand()}`, t),
    classify: (e) => hy3d.classifyError(e),
  },
  // POST /status 用假 subscription_key：凭证无效 → 401；有效 → 返回空 jobs
  hyper3d: {
    call: (t) => hyper3d.queryStatus(`health-probe-${rand()}`, t),
    classify: (e) => hyper3d.classifyError(e),
  },
  // GET 一个不存在的 status URL。
  // ⚠️ 已知局限：fal 的真实 status_url 由 submit 响应动态给出（含 request_id），
  //    无法无害地静态构造。实测无论 key 真假都返回 HTTP 405（真实 key 也是 405），
  //    因此本探测目前只能给出 null（判不出）。
  //    保留它是为了：一旦 fal 调整网关行为开始对坏 key 返 401，这里能自动生效。
  //    若你确认需要 fal 的真实性校验，可靠做法是提交一个最低成本的真任务再看结果，
  //    但那会消耗额度，与"无害探测"的初衷冲突，故不做。
  fal: {
    call: (t) => fal.queryStatus(`${fal.ENDPOINT}/${fal.MODEL}/requests/health-probe-${rand()}/status`, t),
    classify: (e) => fal.classifyError(e),
  },
};

/**
 * 探测所有已配置的 3D 引擎。并行执行，任一失败不影响其他。
 * @param {{hunyuan?:string, hyper3d?:string, fal?:string}} tokens 各引擎凭证（无则跳过）
 * @returns {Promise<Object>} 形如 { hunyuan: {verified, reason}, ... }
 */
export async function probeEngines(tokens = {}) {
  const names = Object.keys(PROBES).filter((n) => tokens[n]);
  if (!names.length) return {};

  const settled = await Promise.allSettled(
    names.map(async (name) => {
      const { call, classify } = PROBES[name];
      return [name, await probeOne(tokens[name], call, classify)];
    })
  );

  const out = {};
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const [name, r] = s.value;
      out[name] = r;
    } else {
      // 理论上到不了这里（probeOne 已兜住所有异常），但防御性处理
      out[`engine-${rand()}`] = { verified: null, reason: 'probe-crashed' };
    }
  }
  return out;
}

/**
 * 带 TTL 缓存的探测。健康检查可能被用户反复点，避免每次都打云端。
 * @param {{hunyuan?:string, hyper3d?:string, fal?:string}} tokens
 * @param {{force?:boolean}} opts
 */
export async function probeEnginesCached(tokens = {}, opts = {}) {
  const now = Date.now();
  if (!opts.force && cache.value && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.value, _cached: true, _probedAt: cache.at };
  }
  const value = await probeEngines(tokens);
  cache = { at: now, value };
  return { ...value, _cached: false, _probedAt: now };
}

/** 供测试或调试用：清空缓存 */
export function resetProbeCache() {
  cache = { at: 0, value: null };
}
