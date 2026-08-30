/**
 * _qa-backlight.mjs — 背光面可见性的量化验证（临时脚本，前缀 _，非产物）
 *
 * 每个场景在「车尾 / 侧后方」机位各拍两张：
 *   A 车可见
 *   B 车 + 轮全部隐藏（只剩背景 + 地面）
 * 两张相减得到「车占据的像素」，再用 Python/Pillow 统计这些像素的亮度分布。
 *
 * 判据：车壳像素里「近黑」(亮度 < 12/255) 的占比越低、暗部 5 分位越亮，
 *       说明背光面越看得清。
 *
 * 用法：node scripts/_qa-backlight.mjs [port]
 */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.argv[2] || 9444);
const CDP_HTTP = `http://127.0.0.1:${PORT}`;
const PAGE_URL = 'http://127.0.0.1:5173/';
const OUT = '/tmp';

const { spawn } = await import('node:child_process');
const fs = await import('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-proxy-server',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,800',
    `--user-data-dir=/tmp/chrome-backlight-${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function waitCDP() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${CDP_HTTP}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP 起不来');
}

const ver = await waitCDP();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

await S('Page.enable');
await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
});
await S('Page.navigate', { url: PAGE_URL });

async function evalJs(expr) {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

let ready = false;
for (let i = 0; i < 120; i++) {
  const v = await evalJs(
    `(() => { const o=document.getElementById('overlay'); return !!(o && !o.classList.contains('show')); })()`
  );
  if (v) { ready = true; break; }
  await sleep(1000);
}
console.log(`模型加载完成：${ready}`);
await sleep(2500);

const presets = JSON.parse(await evalJs(`JSON.stringify(window.__garage.viewer.listPresets())`));

const ANGLES = [
  { key: 'rear', dir: [-1, 0.42, 0.28], dist: 7.4 },
  { key: 'rear-quarter', dir: [-0.78, 0.46, 1], dist: 7.6 },
];

async function shot(path) {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
}

const manifest = [];
for (const p of presets) {
  await evalJs(`window.__garage.app.setEnvironment(${JSON.stringify(p.id)});`);
  await sleep(900);
  for (const a of ANGLES) {
    await evalJs(`(() => {
      const g = window.__garage;
      const c = g.viewer.controls.target.clone();
      const d = new g.THREE.Vector3(${a.dir[0]}, ${a.dir[1]}, ${a.dir[2]}).normalize();
      g.viewer.camera.position.copy(c).addScaledVector(d, ${a.dist});
      g.viewer.controls.update();
      return true;
    })()`);
    await sleep(650);

    await shot(`${OUT}/bl-${p.id}-${a.key}-A.png`);

    // 隐藏车壳 + 车轮
    await evalJs(`(() => {
      const g = window.__garage;
      g.__hidden = [];
      g.viewer.scene.traverse((o) => {
        if (o.name === 'carOuter' || o.name === 'wheelRig') { g.__hidden.push(o); o.visible = false; }
      });
      return g.__hidden.length;
    })()`);
    await sleep(650);
    await shot(`${OUT}/bl-${p.id}-${a.key}-B.png`);

    // 恢复
    await evalJs(`(() => { for (const o of window.__garage.__hidden || []) o.visible = true; return true; })()`);
    await sleep(300);

    manifest.push({ preset: p.id, angle: a.key });
  }
  console.log(`  ${p.id} 拍摄完成`);
}

fs.writeFileSync(`${OUT}/bl-manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\nmanifest: ${OUT}/bl-manifest.json（${manifest.length} 组）`);

await S('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
chrome.kill();
process.exit(0);
