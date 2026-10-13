/**
 * newsBot.mjs — 每日前沿汽车资讯自动搜集 + 生成 + 更新资讯板块
 *
 * 目标：无需人工干预，把实时汽车资讯抓取下来、改写成中文资讯，写进资讯板块
 *       （GET /api/news 已有前端每 30s 轮询消费）。
 *
 * 管线：
 *   1) 抓取：Carscoops RSS（汽车资讯，国内外均可直连，不被墙）。
 *      抓取走「有 HTTPS_PROXY 用 HttpsProxyAgent、无则直连」，兼顾本机/容器/公司网。
 *   2) 生成：用 LLM（复用 chat.mjs 的 getChatKey → qwen-plus 等）把英文资讯
 *      改写成中文 {title, summary, body} 并按内容归类 category(news/race/event)；
 *      无 key 或 LLM 失败则退化为模板（原文标题+摘要），绝不白屏。
 *   3) 去重：.cache/news/seen-articles.json（链接级）+ 扫描库内既有资讯正文里的
 *      原文链接标记（PG/容器 .cache 易失也能挡住重复）。
 *   4) 落库：db.createNews({ title, summary, body, category, source, publishedAt })。
 *
 * 调度：每天 08:00 与 20:00（本地时间）各更新一次；冷启动（重启/部署）也会补跑一次。
 *
 * 环境变量（均可选）：
 *   NEWS_BOT_ENABLED        '0' 关闭（默认开）
 *   NEWS_BOT_PER_RUN        每次最多入库几条（默认 15）
 *   NEWS_BOT_INITIAL_DELAY  冷启动补跑延迟 ms（默认 15000）
 */

import https from 'node:https';
import http from 'node:http';
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
const PER_RUN = Number(process.env.NEWS_BOT_PER_RUN || 15);
const INITIAL_DELAY = Number(process.env.NEWS_BOT_INITIAL_DELAY || 15000);
const LINK_MARK = '—— 原文：'; // 正文里标记原文链接，供跨重启去重（正文不在卡片上渲染）

/** 每日更新时点（本地小时） */
const NEWS_SLOT_HOURS = [8, 20];

/** 资讯源：Carscoops（汽车资讯，国内外可达）。可继续追加 {url, source}。 */
const SOURCE_FEEDS = [{ url: 'https://www.carscoops.com/feed', source: 'Carscoops' }];

/* ------------------------- 代理感知 HTTP（支持跳转） ------------------------- */

function httpRequest(method, url, { headers = {}, body = null, timeoutMs = 25000 } = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === 'http:' ? http : https;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (InspireCarNewsBot/1.0)',
        Accept: '*/*',
        ...headers,
      },
    };
    if (PROXY) opts.agent = new HttpsProxyAgent(PROXY);
    const req = mod.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 4) {
          const next = new URL(res.headers.location, url).href;
          return httpRequest(method, next, { headers, body, timeoutMs }, depth + 1).then(resolve, reject);
        }
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
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
    items.push({ title, link, pubDate, source: source || 'Carscoops', desc });
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
  return { title, summary, body, category: 'news' };
}

/** LLM 改写成中文资讯（含归类 news/race/event）；失败回退模板 */
export async function generateArticle(item) {
  const ak = getChatKey();
  if (ak) {
    const system =
      '你是资深汽车资讯编辑，为「灵感改装 / Inspire Car」撰写简体中文汽车资讯，面向汽车爱好者。';
    const user =
      `把下面这条汽车新闻改写成一条中文资讯。只输出一个 JSON 对象（不要多余文字/代码块），` +
      `字段：title(≤16字，吸引人，去掉来源后缀)、summary(≤60字，一句话概括)、` +
      `body(90-150字，2-3句话讲清看点，专业易懂)、` +
      `category(三选一，按内容判断：news=改装/新车/行业资讯，race=赛事/赛车/赛道，event=车展/发布会/活动)。\n\n` +
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
          const cat = ['news', 'race', 'event'].includes(obj.category) ? obj.category : 'news';
          return {
            title: String(obj.title).slice(0, 40),
            summary: String(obj.summary || '').slice(0, 120),
            body: `${String(obj.body || obj.summary || '')}\n\n${LINK_MARK}${item.link}`.slice(0, 600),
            category: cat,
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

/** 跑一轮：抓取 + 生成 + 去重 + 落库。返回 {ok, added, byCategory, errors} */
export async function runOnce() {
  if (!ENABLED) return { ok: true, skipped: true, reason: 'disabled', added: 0 };
  const seen = loadSeen();
  const existingLinks = await existingLinkSet();
  let added = 0;
  const byCategory = {};
  const errors = [];

  for (const feed of SOURCE_FEEDS) {
    if (added >= PER_RUN) break;
    let items = [];
    try {
      const r = await httpRequest('GET', feed.url, { timeoutMs: 20000 });
      if (r.status >= 200 && r.status < 300) items = parseRss(r.body);
      else errors.push(`${feed.source}: HTTP ${r.status}`);
    } catch (e) {
      errors.push(`${feed.source}: ${e.message}`);
    }
    for (const it of items) {
      if (added >= PER_RUN) break;
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
          category: art.category,
          source: it.source || feed.source,
          publishedAt: it.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString(),
        });
        seen[key] = Date.now();
        existingLinks.add(it.link);
        byCategory[art.category] = (byCategory[art.category] || 0) + 1;
        added += 1;
      } catch (e) {
        errors.push(`create「${it.title}」: ${e.message}`);
      }
    }
  }
  saveSeen(seen);
  return { ok: true, added, byCategory, errors };
}

/* ------------------------- 调度（每天 08:00 / 20:00） ------------------------- */

let slotTimer = null;
let booted = false;

function msUntilNextSlot() {
  const now = new Date();
  for (const h of NEWS_SLOT_HOURS) {
    const t = new Date(now);
    t.setHours(h, 0, 0, 0);
    if (t.getTime() > now.getTime()) return { delay: t.getTime() - now.getTime(), at: t };
  }
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  t.setHours(NEWS_SLOT_HOURS[0], 0, 0, 0);
  return { delay: t.getTime() - now.getTime(), at: t };
}

function scheduleNextSlot() {
  const { delay, at } = msUntilNextSlot();
  const pad = (n) => String(n).padStart(2, '0');
  console.log(`[news-bot] 下一次自动更新：${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`);
  slotTimer = setTimeout(async () => {
    try {
      const r = await runOnce();
      console.log('[news-bot] 定时更新:', JSON.stringify(r));
    } catch (e) {
      console.error('[news-bot] 定时更新失败:', e.message);
    }
    scheduleNextSlot();
  }, delay);
  slotTimer.unref?.();
}

async function runInitial() {
  try {
    const r = await runOnce();
    console.log('[news-bot] 冷启动补跑:', JSON.stringify(r));
  } catch (e) {
    console.error('[news-bot] 冷启动补跑失败:', e.message);
  }
}

/** 启动调度：每天 08:00/20:00 更新 + 冷启动补跑一次。重复调用只生效一次。 */
export function startScheduler() {
  if (!ENABLED) {
    console.log('[news-bot] 已关闭（NEWS_BOT_ENABLED=0）');
    return;
  }
  if (booted) return;
  booted = true;
  console.log(`[news-bot] 资讯调度已启动（每天 08:00 / 20:00 更新，每次最多 ${PER_RUN} 条）`);
  setTimeout(runInitial, INITIAL_DELAY).unref?.();
  scheduleNextSlot();
}

export function stopScheduler() {
  if (slotTimer) clearTimeout(slotTimer);
  slotTimer = null;
  booted = false;
}
