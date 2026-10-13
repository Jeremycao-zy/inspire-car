/**
 * newsBot.mjs — 每日前沿汽车资讯自动搜集 + 生成 + 更新资讯板块
 *
 * 目标：无需人工干预，每天把实时前沿汽车资讯抓取下来、改写成中文资讯，
 *       写进资讯板块（GET /api/news 已有前端每 30s 轮询消费）。
 *
 * 管线：
 *   1) 抓取：Google News RSS（中文，按 改装资讯/赛事/活动 三类，每类多个查询词兜底）。
 *      抓取走「有 HTTPS_PROXY 走代理、无则直连」，兼顾本机/容器/公司网。
 *   2) 生成：优先用 LLM（复用 chat.mjs 的 getChatKey → qwen-plus 等）改写成
 *      {title, summary, body}；无 key 或 LLM 失败则退化为模板（原文标题+摘要），绝不白屏。
 *   3) 去重：① .cache/news/seen-articles.json（链接级，本机 JSON 模式持久）；
 *              ② 扫描库内既有资讯正文里的原文链接（PG/容器 .cache 易失也能挡住重复）。
 *   4) 落库：db.createNews({ title, summary, body, category, source, publishedAt })。
 *
 * 调度：startScheduler() 启动一个每日定时器；冷启动时若库内最新资讯已超过 ~20h
 *       才补跑一次（避免频繁重启反复抓同一批）。
 *
 * 环境变量（均可选）：
 *   NEWS_BOT_ENABLED        '0' 关闭（默认开）
 *   NEWS_BOT_INTERVAL_MS    每日间隔（默认 86400000）
 *   NEWS_BOT_PER_CATEGORY   每类每次最多入库几条（默认 4）
 *   NEWS_BOT_INITIAL_DELAY  冷启动补跑延迟 ms（默认 20000）
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as db from './db.mjs';
import { getChatKey } from './chat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NEWS_DIR = path.join(ROOT, '.cache', 'news');
const SEEN_FILE = path.join(NEWS_DIR, 'seen-articles.json');

const PROXY =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  '';
const ENABLED = (process.env.NEWS_BOT_ENABLED || '1') !== '0';
const DAILY_MS = Number(process.env.NEWS_BOT_INTERVAL_MS || 24 * 60 * 60 * 1000);
const PER_CATEGORY = Number(process.env.NEWS_BOT_PER_CATEGORY || 4);
const INITIAL_DELAY = Number(process.env.NEWS_BOT_INITIAL_DELAY || 20000);
const FRESH_WINDOW_MS = 20 * 60 * 60 * 1000; // 最新资讯超过 20h 才在冷启动补跑
const LINK_MARK = '—— 原文：'; // 正文里标记原文链接，供跨重启去重（正文不在卡片上展示）

/** 三类资讯 -> Google News RSS 查询词（按序尝试，命中足够即停） */
const FEEDS = {
  news: ['汽车改装', '改装车 轮毂', '新能源汽车 发布'],
  race: ['赛车赛事', 'F1 方程式', '汽车 耐力赛'],
  event: ['车展', '新车发布会', '车友会 活动'],
};

/* ------------------------- 代理感知 HTTP ------------------------- */

function httpRequest(method, url, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (InspireCarNewsBot/1.0)',
        Accept: '*/*',
        ...headers,
      },
    };
    if (PROXY) opts.agent = new HttpsProxyAgent(PROXY);
    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function rssUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
}

/* ------------------------- RSS 解析 ------------------------- */

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
function stripCdata(s) {
  return String(s || '').replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
}
function decodeEnt(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripHtml(s) {
  // RSS 的 description 常是「双重编码」（&lt;a&gt;）：先解码出真标签，再去标签，
  // 最后再解码一次兜住 &amp;nbsp; 这类二次编码实体，避免摘要里残留 <a> / &nbsp; 垃圾。
  let t = decodeEnt(String(s || ''));
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEnt(t);
  return t.replace(/\s+/g, ' ').trim();
}
function cleanTitle(title, source) {
  let t = String(title || '').trim();
  if (source) {
    const suffix = ` - ${source}`;
    if (t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();
  }
  return t;
}

/** 解析 RSS XML -> [{title, link, pubDate, source, desc}] */
export function parseRss(xml) {
  const items = [];
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const rawTitle = decodeEnt(stripCdata(tag(b, 'title')));
    const source = decodeEnt(stripCdata(tag(b, 'source'))).trim();
    const link = (tag(b, 'link') || '').trim();
    const pubDate = (tag(b, 'pubDate') || '').trim();
    const desc = stripHtml(stripCdata(tag(b, 'description'))).slice(0, 300);
    const title = cleanTitle(rawTitle, source);
    if (!title || !link) continue;
    items.push({ title, link, pubDate, source: source || '网络', desc });
  }
  return items;
}

/* ------------------------- 去重 ------------------------- */

export function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}
function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSeen(s) {
  try {
    fs.mkdirSync(NEWS_DIR, { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
/** 扫描库内既有资讯正文里的原文链接，用于跨重启/容器去重 */
export async function existingLinkSet() {
  const set = new Set();
  try {
    const all = (await db.listNews({})) || [];
    for (const n of all) {
      const body = String(n.body || '');
      let idx = body.indexOf(LINK_MARK);
      while (idx >= 0) {
        const rest = body.slice(idx + LINK_MARK.length).trim();
        const link = rest.split(/\s/)[0];
        if (link) set.add(link);
        idx = body.indexOf(LINK_MARK, idx + LINK_MARK.length);
      }
    }
  } catch {
    /* ignore */
  }
  return set;
}

/* ------------------------- 内容生成 ------------------------- */

function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** 模板兜底：无 LLM 或 LLM 失败时用原文标题+摘要 */
export function templateArticle(item) {
  const title = item.title.length > 22 ? `${item.title.slice(0, 22)}…` : item.title;
  const summary = (item.desc || item.title).slice(0, 70);
  const body = `${item.desc || item.title}\n\n${LINK_MARK}${item.link}`.slice(0, 500);
  return { title, summary, body };
}

/** LLM 改写成中文资讯；失败回退模板 */
export async function generateArticle(item) {
  const ak = getChatKey();
  if (ak) {
    const system =
      '你是资深汽车资讯编辑，为「灵感改装 / Inspire Car」撰写简体中文汽车资讯，面向改装爱好者。';
    const user =
      `把下面这条汽车新闻改写成一条中文资讯。只输出一个 JSON 对象（不要多余文字/代码块），` +
      `字段：title(≤16字，吸引人，去掉来源后缀)、summary(≤60字，一句话概括)、` +
      `body(90-150字，2-3句话讲清看点，专业易懂)。\n\n` +
      `原始标题：${item.title}\n来源：${item.source}\n摘要：${item.desc || '无'}`;
    try {
      const payload = JSON.stringify({
        model: ak.model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const r = await httpRequest('POST', ak.endpoint, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ak.key}` },
        body: payload,
        timeoutMs: 30000,
      });
      if (r.status >= 200 && r.status < 300) {
        const obj = extractJson(JSON.parse(r.body)?.choices?.[0]?.message?.content);
        if (obj && obj.title) {
          return {
            title: String(obj.title).slice(0, 40),
            summary: String(obj.summary || '').slice(0, 120),
            body: `${String(obj.body || obj.summary || '')}\n\n${LINK_MARK}${item.link}`.slice(0, 600),
          };
        }
      }
    } catch {
      /* 落到模板 */
    }
  }
  return templateArticle(item);
}

/* ------------------------- 主流程 ------------------------- */

/** 跑一轮：抓取 + 生成 + 去重 + 落库。返回 {ok, added, errors} */
export async function runOnce() {
  if (!ENABLED) return { ok: true, skipped: true, reason: 'disabled', added: 0 };
  const seen = loadSeen();
  const existingLinks = await existingLinkSet();
  let added = 0;
  const errors = [];

  for (const [category, queries] of Object.entries(FEEDS)) {
    let count = 0;
    for (const q of queries) {
      if (count >= PER_CATEGORY) break;
      let items = [];
      try {
        const r = await httpRequest('GET', rssUrl(q), { timeoutMs: 15000 });
        if (r.status >= 200 && r.status < 300) items = parseRss(r.body);
        else errors.push(`${category}/${q}: HTTP ${r.status}`);
      } catch (e) {
        errors.push(`${category}/${q}: ${e.message}`);
      }
      for (const it of items) {
        if (count >= PER_CATEGORY) break;
        const key = it.link || it.title;
        if (seen[key] || existingLinks.has(it.link)) {
          seen[key] = Date.now();
          continue;
        }
        try {
          const art = await generateArticle(it);
          await db.createNews({
            title: art.title,
            summary: art.summary,
            body: art.body,
            category,
            source: it.source || '灵感改装编辑部',
            publishedAt: it.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString(),
          });
          seen[key] = Date.now();
          existingLinks.add(it.link);
          count += 1;
          added += 1;
        } catch (e) {
          errors.push(`create「${it.title}」: ${e.message}`);
        }
      }
    }
  }
  saveSeen(seen);
  return { ok: true, added, errors };
}

/* ------------------------- 调度 ------------------------- */

let timer = null;
let booted = false;

async function runInitialIfStale() {
  try {
    const recent = (await db.listNews({})) || [];
    const latest = recent[0]?.publishedAt ? new Date(recent[0].publishedAt).getTime() : 0;
    if (Date.now() - latest < FRESH_WINDOW_MS) {
      console.log('[news-bot] 库内已有较新资讯，冷启动跳过补跑（等每日定时）');
      return;
    }
  } catch {
    /* 读不到就照常补跑 */
  }
  try {
    const r = await runOnce();
    console.log('[news-bot] 冷启动补跑:', JSON.stringify(r));
  } catch (e) {
    console.error('[news-bot] 冷启动补跑失败:', e.message);
  }
}

/** 启动每日调度 + 冷启动补跑。重复调用只生效一次。 */
export function startScheduler() {
  if (!ENABLED) {
    console.log('[news-bot] 已关闭（NEWS_BOT_ENABLED=0）');
    return;
  }
  if (booted) return;
  booted = true;
  console.log(`[news-bot] 每日资讯调度已启动（间隔 ${Math.round(DAILY_MS / 3600000)}h，每类最多 ${PER_CATEGORY} 条）`);
  setTimeout(runInitialIfStale, INITIAL_DELAY).unref?.();
  timer = setInterval(() => {
    runOnce()
      .then((r) => console.log('[news-bot] 每日抓取:', JSON.stringify(r)))
      .catch((e) => console.error('[news-bot] 每日抓取失败:', e.message));
  }, DAILY_MS);
  timer.unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  booted = false;
}
