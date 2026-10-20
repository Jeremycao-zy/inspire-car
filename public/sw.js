/* 灵感改装 PWA Service Worker
 * 作用：缓存应用外壳（HTML/JS/CSS/图标），让「添加到主屏幕」后可离线打开首屏；
 *       /api/ 与 3D 模型等动态资源始终走网络，不拦截、不破坏后端逻辑。
 *
 * 2026-10-21 重写（修「改版后用户一直看到旧页面」）：
 *  · CACHE 版本化：每次发版改后缀，activate 时自动删旧缓存 → 离线兜底也拿到新外壳；
 *  · 页面导航 = 网络优先（3.5s 超时兜底缓存），且成功后【回填缓存】——
 *    旧版「网络成功但不回填」会让缓存里的 index.html 永远停在安装那天，
 *    国内访问 fly.dev 网络一抖动就静默回退到数天前的旧版 UI（正是这次事故根因）；
 *  · 新 SW 安装即 skipWaiting + claim（配合 main.js 的 controllerchange 自动刷新一次）。 */
const CACHE = 'inspire-car-v2';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 后端接口永远走网络
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：网络优先（带 3.5s 超时，网络抖动时不白等），成功即回填缓存，
  // 失败/超时才回退到缓存的首屏（保证离线可开，但绝不长期压住新版本）。
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('/index.html').catch(() => null);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            // 回填：让缓存里的外壳始终跟随最新一次成功访问
            caches.open(CACHE).then((c) => c.put('/index.html', res.clone())).catch(() => {});
          }
          return res;
        })
        .catch(() => null);
      const raced = await Promise.race([
        network,
        new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
      ]);
      if (raced) return raced;
      // 超时：先回缓存顶上，网络请求继续在后台跑完并回填（下次访问就是新的）
      if (cached) return cached;
      const late = await network;
      return late || Response.error();
    })());
    return;
  }

  // 同源静态资源：缓存优先，缺失则回填缓存（资源文件名带 hash，改名即换新，无旧版风险）
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => hit);
      })
    );
  }
});
