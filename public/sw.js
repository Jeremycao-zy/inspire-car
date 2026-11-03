/* 灵感改装 PWA Service Worker
 * 作用：缓存应用外壳（HTML/JS/CSS/图标），让「添加到主屏幕」后可离线打开首屏；
 *       /api/ 与 3D 模型等动态资源始终走网络，不拦截、不破坏后端逻辑。
 * 注意：仅在生产构建（import.meta.env.PROD）下由 main.js 注册。 */
const CACHE = 'inspire-car-v1';
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

  // 页面导航：网络优先，离线回退到缓存的首屏
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }

  // 同源静态资源：缓存优先，缺失则回填缓存
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
