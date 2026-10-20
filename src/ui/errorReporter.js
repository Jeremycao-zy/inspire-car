/**
 * errorReporter.js — 前端错误上报（自建、零依赖）
 *
 * 背景：项目上线后没有任何错误监控，线上用户遇到 JS 报错或接口失败时
 * 开发者收不到任何信息。本模块把错误 POST 到 `/api/client-error`。
 *
 * 三条铁律（违反任何一条都会让"监控"本身变成事故源）：
 * 1. **绝不抛错**。整个模块包在 try/catch 里，任何异常都不能影响业务。
 * 2. **绝不递归**。上报用的 fetch 失败不能再触发上报（已排除自身端点）。
 * 3. **绝不泄露业务数据**。只发错误的 type/message/stack/url/ua，不带任何
 *    用户内容、token、请求体。
 *
 * 去重 + 节流：同一错误只报一次；全局最多每 10 秒发一条。
 */

const ENDPOINT = '/api/client-error';
const THROTTLE_MS = 10_000;   // 全局最小上报间隔
const MAX_QUEUE = 20;         // 积压上限，超出丢弃（宁缺勿滥）

/** @type {Map<string, true>} 已上报过的错误指纹 */
const reported = new Set();
let lastSentAt = 0;
/** @type {Array<object>} 节流期间积压的错误 */
let queue = [];
let inited = false;

/** 生成错误指纹：同 message+url 视为同一错误 */
function fingerprint(type, message, url) {
  return `${type}|${message}|${url}`.slice(0, 300);
}

/** 统一发送入口：先入队，再按节流节奏 flush */
function enqueue(payload) {
  try {
    if (queue.length >= MAX_QUEUE) queue.shift(); // 丢最旧的
    queue.push(payload);
    scheduleFlush();
  } catch {
    /* 静默：入队失败就丢弃，绝不抛 */
  }
}

let flushTimer = 0;
function scheduleFlush() {
  if (flushTimer) return;
  const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastSentAt));
  flushTimer = setTimeout(flush, wait);
}

function flush() {
  flushTimer = 0;
  if (!queue.length) return;
  const payload = queue.shift();
  lastSentAt = Date.now();
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    // sendBeacon 在页面卸载时也能发出，且不受 CORS 预检影响
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) {
      // 成功：若还有积压则继续排
      if (queue.length) scheduleFlush();
      return;
    }
  } catch {
    /* 落到 fetch 降级 */
  }
  // 降级：fetch + keepalive（同样支持页面卸载时发出）
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      // 不读响应、不 then——避免任何 rejection 冒出去
    }).catch(() => {});
  } catch {
    /* 静默 */
  }
  if (queue.length) scheduleFlush();
}

/**
 * 上报一条错误。外部不需要关心节流与去重，调用即可。
 * @param {{type?:string, message:string, stack?:string, url?:string, extra?:object}} err
 */
export function reportError(err) {
  try {
    if (!err || typeof err.message !== 'string' || !err.message) return;
    const type = String(err.type || 'error').slice(0, 40);
    const message = String(err.message).slice(0, 500);
    const url = String(err.url || (typeof location !== 'undefined' ? location.pathname : '')).slice(0, 500);
    const stack = err.stack ? String(err.stack).slice(0, 2000) : '';

    const fp = fingerprint(type, message, url);
    if (reported.has(fp)) return;
    reported.add(fp);
    // 防 Set 无限增长
    if (reported.size > 500) reported.clear();

    enqueue({
      type,
      message,
      url,
      stack,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      ...(err.extra && typeof err.extra === 'object' ? { extra: err.extra } : {}),
    });
  } catch {
    /* 静默 */
  }
}

/** 包装 fetch：对 /api/* 的非 2xx 响应上报（排除自身，防递归） */
function wrapFetch() {
  if (typeof fetch !== 'function') return;
  const orig = fetch;
  window.fetch = function (...args) {
    return orig.apply(this, args).then((res) => {
      try {
        const input = args[0];
        const url = typeof input === 'string'
          ? input
          : (input && input.url) || String(input || '');
        // 只关心自家 API；排除自身端点，否则上报失败会触发再上报
        if (!url.includes(ENDPOINT) && url.includes('/api/') && !res.ok) {
          reportError({
            type: 'api',
            message: `HTTP ${res.status} ${res.statusText || ''}`.trim(),
            url: url.slice(0, 500),
          });
        }
      } catch {
        /* 静默 */
      }
      return res;
    });
    // 注意：不加 .catch —— fetch 的 rejection 由下面的全局处理器统一收
  };
}

/**
 * 初始化错误上报。应在应用入口调用一次。
 * 重复调用安全（有 inited 守卫）。
 */
export function initErrorReporter() {
  if (inited) return;
  inited = true;
  try {
    // 1. 同步运行时错误
    window.addEventListener('error', (e) => {
      reportError({
        type: 'error',
        message: e.message || 'unknown error',
        stack: e.error && e.error.stack ? e.error.stack : '',
        extra: {
          filename: e.filename ? String(e.filename).slice(0, 300) : '',
          lineno: e.lineno,
          colno: e.colno,
        },
      });
    });

    // 2. Promise 未处理拒绝
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      reportError({
        type: 'unhandledrejection',
        message: r instanceof Error ? r.message : String(r).slice(0, 500),
        stack: r instanceof Error && r.stack ? r.stack : '',
      });
    });

    // 3. API 失败上报
    wrapFetch();

    // 4. 页面卸载前把积压发出去
    window.addEventListener('pagehide', () => {
      try { flush(); } catch { /* 静默 */ }
    });
  } catch {
    /* 静默：监控初始化失败不该影响应用启动 */
  }
}
