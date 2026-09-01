/**
 * server/static.mjs — 生产模式的静态文件服务（零第三方依赖，纯 Node 内置模块）
 *
 * 为什么需要：
 *   本地开发是「Vite dev server(5173) + API server(8787)」两个进程，前端靠 Vite 的
 *   proxy 把 /api 转发到 8787。部署到云平台时只能暴露一个端口，于是必须让 API server
 *   顺带把构建产物 dist/ 一起服务掉，实现「单进程单端口」。
 *
 * 设计红线：
 *   1. 默认关闭。只有显式 SERVE_STATIC=1（或 =auto 且 dist/index.html 存在）才启用，
 *      保证本地 `npm run dev` 的行为完全不变。
 *   2. 只处理非 /api 请求。/api/generate 是 SSE 流式响应，绝不能被静态逻辑碰到。
 *   3. 路径穿越必须拒绝。要上公网，public/models 之外的一个字节都不能被读出来。
 *   4. index.html 必须 no-cache（否则发版后用户拿不到新版本），
 *      dist/assets/* 带 hash 文件名，可长缓存 immutable。
 *
 * 能力：
 *   - 正确的 MIME（含 .glb / .gltf / .woff2 / .ktx2 / .wasm）
 *   - ETag / Last-Modified + If-None-Match → 304（44MB 的 GLB 重复打开时省流量）
 *   - 单段 Range 请求 → 206（大 GLB 断点续传 / 拖拽 seek）
 *   - HEAD 请求
 *   - 可选的 SPA fallback（本项目无前端路由，默认关闭）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/* ------------------------- MIME ------------------------- */

/**
 * 静态资源 MIME 表。
 * .glb / .gltf 是重点：Three.js 的 GLTFLoader 多数情况能容错，但部分 CDN / 平台
 * 会因错误 MIME 触发额外转换，别赌，显式声明。
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.drc': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream',
  '.basis': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.manifest': 'text/cache-manifest',
};

/** 兜底 MIME：宁可当二进制下载，也不要让浏览器猜成 HTML 造成 XSS */
const DEFAULT_MIME = 'application/octet-stream';

/**
 * 查 MIME。未知扩展名一律 application/octet-stream。
 * @param {string} filePath 绝对路径或文件名
 * @returns {string}
 */
function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || DEFAULT_MIME;
}

/* ------------------------- 缓存策略 ------------------------- */

/**
 * 按相对路径决定 Cache-Control。
 *   - index.html / 根路径：no-cache —— 发版后必须立刻拿到新版本
 *   - dist/assets/*：文件名带 content hash，内容变了文件名就变了 → 可长缓存 immutable
 *   - 其它（public/ 直拷，如 /models/*.glb、/fonts/*.woff2）：文件名无 hash，
 *     给一个短一点的 max-age，靠 ETag 做 304 校验
 *
 * @param {string} relPath 相对 dist/ 的 POSIX 路径，如 'assets/index-xxx.js'
 * @returns {string}
 */
function cacheControlOf(relPath) {
  const p = relPath.replace(/^\/+/, '');
  if (p === '' || p === 'index.html' || p.endsWith('/index.html')) {
    return 'no-cache, must-revalidate';
  }
  if (p.startsWith('assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

/* ------------------------- 路径安全 ------------------------- */

/**
 * 把 URL pathname 安全地映射为 dist/ 内的绝对路径。
 *
 * 防护分三层，任何一层失败都返回 null（调用方应回 403）：
 *   1. decodeURIComponent —— 拦住 %2e%2e%2f 这类编码后的穿越
 *   2. path.posix.normalize —— 折叠 ../ 与 ./（绝对路径的 .. 会被吞到根）
 *   3. path.relative 前缀校验 —— 最终落点必须在 root 内
 *
 * @param {string} root dist 目录的绝对路径
 * @param {string} pathname URL 的 pathname，如 '/assets/index.js'
 * @returns {string|null} 安全则绝对路径，不安全则 null
 */
export function safeResolve(root, pathname) {
  let decoded;
  try {
    // 先解一层编码：URL 里的 %2e%2e 必须先还原才能被 normalize 折叠
    decoded = decodeURIComponent(pathname);
  } catch {
    // 非法 percent-encoding（如 %zz）
    return null;
  }

  // NUL 字节：截断类攻击
  if (decoded.indexOf('\0') !== -1) return null;

  // 反斜杠在 POSIX 上是合法文件名字符，但 Windows 上会被当分隔符，统一当穿越拒绝
  if (decoded.indexOf('\\') !== -1) return null;

  // normalize 会把 '/a/../../etc/passwd' 折叠成 '/etc/passwd'
  const normalized = path.posix.normalize(decoded);

  // normalize 后仍是绝对路径（URL pathname 必然以 / 开头），去掉前导斜杠变相对路径
  let rel = normalized.replace(/^\/+/, '');

  // 空路径 → 首页
  if (rel === '') rel = 'index.html';

  // 显式再拦一次：任何 '..' 段都拒绝（normalize 之后理论上不该出现，做纵深防御）
  const segs = rel.split('/');
  if (segs.some((s) => s === '..')) return null;

  const abs = path.resolve(root, rel);

  // 最终落点必须在 root 内（含 root 自身）
  const rel2 = path.relative(root, abs);
  if (rel2 === '' || (!rel2.startsWith('..') && !path.isAbsolute(rel2))) {
    return abs;
  }
  return null;
}

/* ------------------------- Range ------------------------- */

/**
 * 解析单段 Range 头。
 * @param {string|undefined} header 原始 Range 头
 * @param {number} size 文件总字节
 * @returns {{start:number,end:number}|{unsatisfiable:true}|null}
 *          null 表示「没有 Range 头」或「Range 无法解析，按完整响应处理」
 */
export function parseRange(header, size) {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // 多段 Range 或非法格式 → 退回完整响应（符合 RFC 9110）

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // bytes=-N：取最后 N 字节
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

/* ------------------------- 开关判定 ------------------------- */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * 判断是否启用静态服务。
 *
 * SERVE_STATIC 取值（大小写不敏感）：
 *   1/true/yes/on → 强制开启
 *   0/false/no/off → 强制关闭（默认）
 *   auto          → dist/index.html 存在就开启
 *   未设置        → 关闭，保证本地 dev 行为完全不变
 *
 * @param {string} root dist 目录绝对路径
 * @param {string|undefined} flag SERVE_STATIC 环境变量值
 * @returns {{enabled:boolean, reason:string}}
 */
export function resolveStaticMode(root, flag) {
  const v = String(flag == null ? '' : flag).trim().toLowerCase();

  if (FALSY.has(v)) return { enabled: false, reason: 'SERVE_STATIC=0（显式关闭）' };
  if (v === 'auto') {
    const ok = fileExistsSync(path.join(root, 'index.html'));
    return {
      enabled: ok,
      reason: ok ? 'SERVE_STATIC=auto，dist/index.html 存在' : 'SERVE_STATIC=auto，但 dist/index.html 不存在',
    };
  }
  if (TRUTHY.has(v) || v === '') {
    // v === '' 即未设置 → 默认关闭
    if (v === '') return { enabled: false, reason: 'SERVE_STATIC 未设置（默认关闭，保持本地 dev 行为）' };
    const ok = fileExistsSync(path.join(root, 'index.html'));
    if (!ok) {
      return { enabled: false, reason: 'SERVE_STATIC=1 但 dist/index.html 不存在，已自动降级为纯 API 模式' };
    }
    return { enabled: true, reason: 'SERVE_STATIC=1' };
  }
  return { enabled: false, reason: `SERVE_STATIC=${flag} 无法识别，按关闭处理` };
}

/** @param {string} p 绝对路径 @returns {boolean} */
function fileExistsSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ------------------------- 静态服务 ------------------------- */

/**
 * 创建静态文件服务器。
 *
 * @param {object} opts
 * @param {string} opts.root           dist 目录绝对路径
 * @param {string} [opts.flag]         SERVE_STATIC 环境变量值
 * @param {string} [opts.spaFallback]  SPA_FALLBACK 环境变量值，'1' 开启
 * @returns {{enabled:boolean, root:string, reason:string, spaFallback:boolean,
 *            handle:(req:import('node:http').IncomingMessage,
 *                    res:import('node:http').ServerResponse,
 *                    pathname:string)=>Promise<void>}}
 */
export function createStaticServer({ root, flag, spaFallback } = {}) {
  const absRoot = path.resolve(root);
  const mode = resolveStaticMode(absRoot, flag);
  const useSpaFallback = TRUTHY.has(String(spaFallback == null ? '' : spaFallback).trim().toLowerCase());

  /**
   * 处理一个静态请求。无论成功失败都会结束响应。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   * @returns {Promise<void>}
   */
  async function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendPlain(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const abs = safeResolve(absRoot, pathname);
    if (!abs) {
      // 路径穿越 / 非法编码
      sendPlain(res, 403, 'Forbidden');
      return;
    }

    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      // 文件不存在
      if (useSpaFallback && !looksLikeFile(pathname)) {
        await sendIndex(res, req.method === 'HEAD');
        return;
      }
      sendPlain(res, 404, 'Not Found');
      return;
    }

    // 目录 → 尝试目录下的 index.html，否则 404（绝不列目录）
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      let ist;
      try {
        ist = await fsp.stat(idx);
      } catch {
        sendPlain(res, 404, 'Not Found');
        return;
      }
      if (ist.isFile()) {
        const rel = path.relative(absRoot, idx).split(path.sep).join('/');
        await sendFile(req, res, idx, ist, rel);
        return;
      }
      sendPlain(res, 404, 'Not Found');
      return;
    }

    if (!st.isFile()) {
      sendPlain(res, 404, 'Not Found');
      return;
    }

    const rel = path.relative(absRoot, abs).split(path.sep).join('/');
    await sendFile(req, res, abs, st, rel);
  }

  /** 无扩展名（或未知扩展名）时认为是"路由"，才值得 fallback 到 index.html */
  function looksLikeFile(p) {
    return path.extname(path.basename(p)) !== '';
  }

  async function sendIndex(res, isHead) {
    const idx = path.join(absRoot, 'index.html');
    try {
      const st = await fsp.stat(idx);
      if (st.isFile()) {
        await sendFile({ method: isHead ? 'HEAD' : 'GET', headers: {} }, res, idx, st, 'index.html');
        return;
      }
    } catch {
      /* 落到 404 */
    }
    sendPlain(res, 404, 'Not Found');
  }

  /**
   * 发送文件内容（含 ETag / 304 / Range / HEAD）。
   * @param {{method:string, headers:object}} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} file 绝对路径
   * @param {import('node:fs').Stats} st
   * @param {string} rel 相对 dist/ 的 POSIX 路径
   * @returns {Promise<void>}
   */
  async function sendFile(req, res, file, st, rel) {
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const lastModified = st.mtime.toUTCString();
    const base = {
      'Content-Type': mimeOf(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControlOf(rel),
      ETag: etag,
      'Last-Modified': lastModified,
      'X-Content-Type-Options': 'nosniff',
    };

    // 条件请求：ETag 优先，其次 Last-Modified
    const inm = req.headers['if-none-match'];
    if (inm && matchesEtag(inm, etag)) {
      res.writeHead(304, { ...base, 'Content-Length': 0 });
      res.end();
      return;
    }
    const ims = req.headers['if-modified-since'];
    if (!inm && ims && Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000) {
      res.writeHead(304, { ...base, 'Content-Length': 0 });
      res.end();
      return;
    }

    const range = parseRange(req.headers.range, st.size);
    if (range && range.unsatisfiable) {
      res.writeHead(416, {
        ...base,
        'Content-Range': `bytes */${st.size}`,
        'Content-Length': 0,
      });
      res.end();
      return;
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      res.end();
      return;
    }

    if (range) {
      const len = range.end - range.start + 1;
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
        'Content-Length': len,
      });
      pipeFile(req, res, file, range.start, range.end);
      return;
    }

    res.writeHead(200, { ...base, 'Content-Length': st.size });
    pipeFile(req, res, file, 0, st.size - 1);
  }

  /**
   * 用 ReadStream 把文件推给响应（44MB 的 GLB 不能一次性读进内存）。
   * @param {object} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} file 绝对路径
   * @param {number} start
   * @param {number} end
   * @returns {void}
   */
  function pipeFile(req, res, file, start, end) {
    const stream = fs.createReadStream(file, { start, end });
    let destroyed = false;

    req.on('close', () => {
      if (!destroyed) {
        destroyed = true;
        stream.destroy();
      }
    });

    stream.on('error', () => {
      if (!destroyed) {
        destroyed = true;
        try {
          res.destroy();
        } catch {
          /* 连接已断，忽略 */
        }
      }
    });

    stream.pipe(res);
  }

  return {
    enabled: mode.enabled,
    root: absRoot,
    reason: mode.reason,
    spaFallback: useSpaFallback,
    handle,
  };
}

/**
 * 弱比较 ETag：支持 `*` 与逗号分隔列表。
 * @param {string} header If-None-Match 原始值
 * @param {string} etag 当前实体 ETag
 * @returns {boolean}
 */
function matchesEtag(header, etag) {
  const raw = String(header || '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  const normalize = (s) => s.trim().replace(/^W\//, '');
  const target = normalize(etag);
  return raw.split(',').some((candidate) => normalize(candidate) === target);
}

/**
 * 发送纯文本响应（错误页统一走这里，避免泄露路径等内部信息）。
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {string} text
 * @param {object} [extraHeaders]
 * @returns {void}
 */
function sendPlain(res, code, text, extraHeaders = {}) {
  const buf = Buffer.from(`${text}\n`, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(buf);
}
