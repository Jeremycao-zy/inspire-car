/**
 * clientErrors.mjs — 客户端错误收集（自建、零依赖、零成本）
 *
 * 背景：项目上线后完全没有错误监控，线上用户遇到 JS 报错或接口失败时
 * 开发者收不到任何信息。本模块提供一个 `POST /api/client-error` 端点，
 * 把前端捕获的错误追加写入 `.cache/client-errors.jsonl`，用人眼/脚本查看。
 *
 * 设计原则（都是踩过坑换来的）：
 * 1. **永远成功返回**。收集失败绝不能影响用户——这个接口自己挂掉是最讽刺的事故。
 * 2. **限流 + 限额**。没有节流的话，一个死循环报错的页面几小时就能写满磁盘。
 * 3. **严格校验输入**。这是公网端点，字段类型/长度必须卡死，防止被当免费存储刷。
 * 4. **不碰凭证、不碰图片内容**。只收错误元信息，绝不接收业务数据。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据落在 .cache 下，与 models/plans 等同级，Docker 里已被挂载到持久卷
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const LOG_FILE = path.join(CACHE_DIR, 'client-errors.jsonl');

// ---- 限额参数 ----
const MAX_LINES = 5000;          // 超过则从头截断，保留最近的一部分
const MAX_BODY_BYTES = 8 * 1024; // 请求体上限 8KB，超出直接拒
const MAX_STACK_CHARS = 2000;    // 单条 stack 截断长度
const MAX_MSG_CHARS = 500;
const MAX_URL_CHARS = 500;
const MAX_UA_CHARS = 300;

// ---- 去重 / 限流（进程内内存态，重启即清零，可接受）----
/** @type {Map<string, number>} key: `${msg}|${url}` -> 上次记录时间戳 */
const seen = new Map();
const DEDUPE_WINDOW_MS = 60_000;   // 同一错误 1 分钟内只记一次
const THROTTLE_MS = 5_000;         // 全局最小记录间隔
let lastWriteAt = 0;
const MAX_SEEN_ENTRIES = 2000;     // 防 Map 无限增长

/**
 * 读取 JSON 请求体，带大小上限。
 * @returns {Promise<object|null>} 超限/解析失败返回 null
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** 安全截取字符串：非字符串/超长都处理掉 */
function clip(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.slice(0, max);
  // 去掉换行，保证 jsonl 每行一条（换行会破坏格式）
  return s.replace(/[\r\n]+/g, ' ');
}

/**
 * 文件超过 MAX_LINES 时截断，保留后 2/3。
 * 用同步读写在请求线程里跑——这个文件很小（<1MB），不值得引入队列。
 */
function trimIfTooBig() {
  try {
    const stat = fs.statSync(LOG_FILE);
    // 粗估：每行平均 200 字节
    if (stat.size < MAX_LINES * 200) return;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    if (lines.length <= MAX_LINES) return;
    const keep = lines.slice(Math.floor(MAX_LINES / 3));
    fs.writeFileSync(LOG_FILE, keep.join('\n'));
  } catch {
    // 文件不存在或读失败：无所谓，下次 append 会重建
  }
}

/**
 * 处理 POST /api/client-error。
 * 注意：本函数永不抛错，也永不返回非 2xx——收集失败不该让用户看到异常。
 */
export async function handleClientError(req, res) {
  const ok = () => {
    res.writeHead(204);
    res.end();
  };

  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return ok();

    const msg = clip(body.message, MAX_MSG_CHARS);
    if (!msg) return ok(); // 没有 message 的记录没有价值

    const url = clip(body.url, MAX_URL_CHARS);
    const type = clip(body.type, 40) || 'error';
    const ua = clip(body.ua, MAX_UA_CHARS) || clip(req.headers['user-agent'], MAX_UA_CHARS);
    const stack = clip(body.stack, MAX_STACK_CHARS);

    // ---- 去重：同一 message+url 在窗口内只记一次 ----
    const key = `${type}|${msg}|${url}`;
    const now = Date.now();
    const lastSeen = seen.get(key);
    if (lastSeen && now - lastSeen < DEDUPE_WINDOW_MS) return ok();

    // ---- 全局限流：两次记录之间至少隔 THROTTLE_MS ----
    if (now - lastWriteAt < THROTTLE_MS) {
      // 仍然更新 seen，避免节流期间同一错误反复命中
      seen.set(key, now);
      return ok();
    }

    seen.set(key, now);
    lastWriteAt = now;

    // seen Map 清理，防止长期运行内存膨胀
    if (seen.size > MAX_SEEN_ENTRIES) {
      for (const [k, t] of seen) {
        if (now - t > DEDUPE_WINDOW_MS) seen.delete(k);
      }
    }

    const record = {
      at: new Date(now).toISOString(),
      type,
      message: msg,
      url,
      ua,
      ...(stack ? { stack } : {}),
      // extra 只接受浅层小对象，深嵌套/大对象一律丢弃
      ...(body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra)
        ? { extra: clip(JSON.stringify(body.extra).slice(0, 500), 500) }
        : {}),
    };

    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.appendFile(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
    trimIfTooBig();
  } catch {
    // 静默失败：写入出错不该影响用户，也不该在这里再报一次错
  }
  ok();
}

/** 供运维/脚本读取日志路径 */
export function getLogPath() {
  return LOG_FILE;
}
