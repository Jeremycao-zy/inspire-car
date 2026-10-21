/**
 * server/admin.mjs — 运营看板（只读）与访问统计
 *
 * 功能：
 *   1) trackVisit(req, u)      —— 在每个请求入口记录一次访问到 .cache/analytics/visits.jsonl
 *   2) handleAdmin(...)        —— 提供以下路由（在 staticServer 之前拦截）：
 *        GET  /admin                 看板页（未登录显示登录框，已登录显示仪表盘）
 *        POST /api/admin/login       提交令牌，成功种下 admin_sid cookie
 *        POST /api/admin/logout      清空 cookie
 *        GET  /api/admin/stats       聚合后的运营数据 JSON（需鉴权）
 *
 * 鉴权：优先读 ADMIN_TOKEN 环境变量；未设置时首次运行生成随机令牌并写入
 *       .cache/admin-token.txt（因 .cache 在 Fly 卷上，重启后仍稳定）。令牌会打印到启动日志。
 *
 * 数据来源（全部只读，不修改任何业务数据）：
 *   - 访问日志：.cache/analytics/visits.jsonl
 *   - 业务资产：.cache/{users,plans,wheels,forum,news} 下的 JSON 文件
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const ANALYTICS_DIR = path.join(CACHE, 'analytics');
const VISITS_FILE = path.join(ANALYTICS_DIR, 'visits.jsonl');
const TOKEN_FILE = path.join(CACHE, 'admin-token.txt');

/* 确保目录存在 */
try { fs.mkdirSync(ANALYTICS_DIR, { recursive: true }); } catch {}

/* 解析看板令牌 */
let adminToken = process.env.ADMIN_TOKEN || '';
if (!adminToken) {
  try { adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!adminToken) {
    adminToken = crypto.randomBytes(9).toString('base64url');
    try { fs.writeFileSync(TOKEN_FILE, adminToken); } catch {}
  }
  console.log('[admin] 看板令牌未通过 ADMIN_TOKEN 设置，已生成并存入 .cache/admin-token.txt：', adminToken);
} else {
  console.log('[admin] 看板已启用（ADMIN_TOKEN 来自环境变量）');
}

/* ------------------------- 实时推送（SSE） ------------------------- */
/* 看板打开后会建立一条 SSE 长连接；有新访问时服务端立即推送快照，
 * 另外每 5 秒主动推一次（覆盖「新增用户/方案」这类不触发访问记录的资产变化）。 */
const sseClients = new Set();
let broadcastTimer = null;

function broadcastStats() {
  if (sseClients.size === 0) return;
  let payload;
  try { payload = JSON.stringify(buildStats()); } catch { return; }
  const frame = `data: ${payload}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

/* 访问记录触发推送时做 800ms 节流，避免高并发下重复计算 */
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastStats();
  }, 800);
}

/* ------------------------- 访问记录 ------------------------- */

const STATIC_EXT = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.map'];

/**
 * 在请求入口调用。只记录「页面/资源」级 GET 访问（排除 /api 与 /admin 自身）。
 * 写失败静默忽略，绝不干扰主流程。
 */
export function trackVisit(req, u) {
  try {
    if (req.method !== 'GET') return;
    const p = u.pathname;
    if (p.startsWith('/api/') || p.startsWith('/admin')) return;
    // 静态资源（js/css/图片）也记，但单独标注，看板可按需过滤；这里全记，统计"访问量"
    const ip = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const entry = {
      t: new Date().toISOString(),
      ip,
      path: p,
      ua: req.headers['user-agent'] || '',
      ref: req.headers['referer'] || '',
      asset: STATIC_EXT.some((e) => p.toLowerCase().endsWith(e)),
    };
    fsp.appendFile(VISITS_FILE, JSON.stringify(entry) + '\n').catch(() => {});
    scheduleBroadcast(); // 有新访问 → 立即推给所有看板连接
  } catch { /* 忽略 */ }
}

/* ------------------------- 鉴权辅助 ------------------------- */

function isAuthed(req, u) {
  const q = u.searchParams.get('token');
  if (q && q === adminToken) return true;
  const cookie = req.headers.cookie || '';
  return /(?:^|;\s*)admin_sid=1\b/.test(cookie);
}

function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `admin_sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

/* ------------------------- 统计聚合 ------------------------- */

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function countDirFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

function recentPlanFiles(dir, n = 5) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ id: f.replace(/\.json$/, ''), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n);
  } catch { return []; }
}

/* 判定一次访问是否为「真人页面访问」：排除 Service Worker 心跳、favicon、
 * 静态资源(css/js/图片/字体)、以及爬虫/机器人 UA。这一口径下得到的数字
 * 才接近真实的「人来逛了你的网站」次数，不会被自动轮询和扫描虚高。 */
function isHumanView(e) {
  const p = (e.path || '').toLowerCase();
  if (p === '/sw.js' || p === '/favicon.ico') return false;
  // 常见扫描器/探针路径：即使 UA 不像 bot 也要排除（WP 探测、sitemap、robots、.env、phpmyadmin 等）
  if (p.startsWith('/wp-') || p.startsWith('/wp_') || p === '/xmlrpc.php' ||
      p.startsWith('/sitemap') || p === '/robots.txt' || p.includes('.env') ||
      p.includes('phpmyadmin') || p.startsWith('/.git')) return false;
  if (STATIC_EXT.some((ext) => p.endsWith(ext))) return false;
  const ua = (e.ua || '').toLowerCase();
  if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|python-requests|curl|go-http|node-fetch|axios|http-client/.test(ua)) return false;
  return true;
}

function aggregateVisits() {
  const today = new Date().toISOString().slice(0, 10);
  let raw = '';
  try { raw = fs.readFileSync(VISITS_FILE, 'utf8'); } catch { raw = ''; }
  const lines = raw.split('\n').filter(Boolean);
  // 只取末尾 20000 行，避免文件过大时解析过慢
  const tail = lines.length > 20000 ? lines.slice(-20000) : lines;
  const total = tail.length;

  let todayCount = 0;
  let humanTotal = 0;
  let humanToday = 0;
  const uniqToday = new Set();
  const uniqTotal = new Set();
  const humanUniqToday = new Set();
  const humanUniqTotal = new Set();
  const dayMap = new Map(); // date -> {views, ips:Set}
  const pathCount = new Map();
  const recent = [];
  const byHour = new Array(24).fill(0); // 按北京时区(UTC+8)的小时分布
  const byDevice = { mobile: 0, desktop: 0, bot: 0, other: 0 };
  let firstDate = '';

  for (const line of tail) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const d = (e.t || '').slice(0, 10);
    if (!d) continue;
    if (d === today) { todayCount++; if (e.ip) uniqToday.add(e.ip); }
    if (e.ip) uniqTotal.add(e.ip);
    // 真人页面访问（剔除 SW 心跳 / favicon / 静态资源 / 爬虫）
    if (isHumanView(e)) {
      humanTotal++;
      if (d === today) { humanToday++; if (e.ip) humanUniqToday.add(e.ip); }
      if (e.ip) humanUniqTotal.add(e.ip);
    }
    if (!dayMap.has(d)) dayMap.set(d, { views: 0, ips: new Set() });
    const dm = dayMap.get(d); dm.views++; if (e.ip) dm.ips.add(e.ip);
    if (e.path) pathCount.set(e.path, (pathCount.get(e.path) || 0) + 1);
    // 端分布 + 小时分布（北京时区 = UTC+8）
    const ua = (e.ua || '').toLowerCase();
    if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|python-requests|curl|go-http|node-fetch|axios|http-client/.test(ua)) byDevice.bot++;
    else if (/iphone|ipod|android|mobile|ipad|tablet|harmonyos|micromessenger/.test(ua)) byDevice.mobile++;
    else if (/macintosh|windows nt|windows|linux|x11|crkey|playstation/.test(ua)) byDevice.desktop++;
    else byDevice.other++;
    const dt = new Date(e.t || '');
    if (!isNaN(dt.getTime())) {
      byHour[(dt.getUTCHours() + 8) % 24]++;
      const fd = (e.t || '').slice(0, 10);
      if (!firstDate || fd < firstDate) firstDate = fd;
    }
    recent.push(e);
  }

  // 最近 14 天（含今天，按日期升序）
  const days = [];
  const base = new Date();
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(base.getTime() - i * 86400000);
    const key = dt.toISOString().slice(0, 10);
    const dm = dayMap.get(key);
    days.push({ date: key, views: dm ? dm.views : 0, uniq: dm ? dm.ips.size : 0 });
  }

  const topPaths = [...pathCount.entries()]
    .filter(([p]) => !STATIC_EXT.some((e) => p.toLowerCase().endsWith(e))) // 热门页只算页面，不算静态资源
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));

  const recentVisitors = recent.slice(-25).reverse().map((e) => ({
    t: (e.t || '').replace('T', ' ').slice(0, 19),
    ip: e.ip,
    path: e.path,
    ua: e.ua,
    ref: e.ref,
  }));

  return {
    total,
    today: todayCount,
    uniqueToday: uniqToday.size,
    uniqueTotal: uniqTotal.size,
    humanTotal,
    humanToday,
    humanUniqueToday: humanUniqToday.size,
    humanUniqueTotal: humanUniqTotal.size,
    last14: days,
    topPaths,
    recent: recentVisitors,
    byHour,
    byDevice,
    firstDate,
  };
}

function aggregateAssets() {
  const users = readJsonSafe(path.join(CACHE, 'users', 'users.json'), []);
  const userArr = Array.isArray(users) ? users : [];
  const recentUsers = userArr.slice(-6).reverse().map((u) => ({
    username: u.username || u.id || '(未知)',
    email: u.email || '',
    phone: u.phone || '',
    createdAt: u.createdAt || u.created_at || '',
  }));
  return {
    users: userArr.length,
    plans: countDirFiles(path.join(CACHE, 'plans')),
    wheels: countDirFiles(path.join(CACHE, 'wheels')),
    forumTopics: (readJsonSafe(path.join(CACHE, 'forum', 'topics.json'), []) || []).length,
    forumReplies: (readJsonSafe(path.join(CACHE, 'forum', 'replies.json'), []) || []).length,
    news: (readJsonSafe(path.join(CACHE, 'news', 'news.json'), []) || []).length,
    recentUsers,
    recentPlans: recentPlanFiles(path.join(CACHE, 'plans'), 5),
  };
}

function buildStats() {
  return {
    generatedAt: new Date().toISOString(),
    today: new Date().toISOString().slice(0, 10),
    visits: aggregateVisits(),
    assets: aggregateAssets(),
  };
}

/* ------------------------- 路由分发 ------------------------- */

const DASHBOARD_HTML = readDashboardHtml();

function readDashboardHtml() {
  try { return fs.readFileSync(path.join(__dirname, 'admin-dashboard.html'), 'utf8'); }
  catch { return '<h1>看板模板缺失：server/admin-dashboard.html</h1>'; }
}

export async function handleAdmin(req, res, u) {
  const p = u.pathname;

  // 登录
  if (p === '/api/admin/login' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let token = '';
    try { token = JSON.parse(body).token || ''; } catch {}
    if (token === adminToken) {
      setCookie(res, '1', 60 * 60 * 24 * 30);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { ok: false, error: '令牌错误' });
  }

  // 登出
  if (p === '/api/admin/logout') {
    setCookie(res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  // 实时流（SSE）：已登录的看板长连接，持续推送最新运营数据
  if (p === '/api/admin/stream') {
    if (!isAuthed(req, u)) return sendJson(res, 401, { error: '未授权' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(buildStats())}\n\n`); // 首帧立即送达
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000); // 保活
    const tick = setInterval(() => { try { res.write(`data: ${JSON.stringify(buildStats())}\n\n`); } catch {} }, 5000); // 资产变化兜底
    req.on('close', () => { clearInterval(hb); clearInterval(tick); sseClients.delete(res); });
    return;
  }

  // 统计数据
  if (p === '/api/admin/stats') {
    if (!isAuthed(req, u)) return sendJson(res, 401, { error: '未授权' });
    return sendJson(res, 200, buildStats());
  }

  // 看板页
  if (p === '/admin' || p === '/admin/') {
    if (!isAuthed(req, u)) return sendHtml(res, loginHtml());
    return sendHtml(res, DASHBOARD_HTML);
  }

  return sendJson(res, 404, { error: 'not found' });
}

function loginHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>灵感改装 · 运营看板登录</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#1e293b;padding:32px 36px;border-radius:16px;width:360px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:18px;margin:0 0 6px} p{color:#94a3b8;font-size:13px;margin:0 0 20px}
label{display:block;font-size:13px;margin-bottom:6px;color:#cbd5e1}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:14px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}
button:hover{background:#1d4ed8}
#msg{color:#fca5a5;font-size:12px;margin-top:12px;min-height:16px}
</style></head><body><div class="card">
<h1>运营看板登录</h1><p>输入看板令牌（启动日志 / ADMIN_TOKEN）</p>
<label>令牌</label><input id="tok" type="password" placeholder="粘贴令牌">
<button id="go">进入看板</button><div id="msg"></div>
</div><script>
const btn=document.getElementById('go');
btn.onclick=async()=>{
  const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('tok').value})});
  if(r.ok){location.href='/admin';}else{document.getElementById('msg').textContent='令牌错误';}
};
</script></body></html>`;
}
