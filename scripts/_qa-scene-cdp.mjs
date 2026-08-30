/**
 * _qa-scene-cdp.mjs — 场景/灯光视觉自检（临时脚本，前缀 _，非产物）
 *
 * 用 headless Chrome + CDP 打开真实页面，逐个套用 6 个场景预设，
 * 每个场景从「车头 / 车尾 / 侧后方」各截一张，用来证明**背光面看得清**。
 *
 * 同时输出每个场景的灯光清单（灯数 / 投影灯数 / 背光强度），
 * 并捕获 console.error 与未捕获异常。
 *
 * 用法：node scripts/_qa-scene-cdp.mjs [port]
 * 前置：dev 服务在 127.0.0.1:5173 运行；本机有 /Applications/Google Chrome.app
 */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_HTTP_PORT = Number(process.argv[2] || 9333);
const CDP_HTTP = `http://127.0.0.1:${CDP_HTTP_PORT}`;
const PAGE_URL = 'http://127.0.0.1:5173/';
const OUT = '/tmp';

const { spawn } = await import('node:child_process');
const fs = await import('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 启动 Chrome ---------------- */

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_HTTP_PORT}`,
    '--no-proxy-server',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--window-size=1440,900',
    `--user-data-dir=/tmp/chrome-scene-profile-${CDP_HTTP_PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function waitCDP() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${CDP_HTTP}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('CDP 起不来');
}

const ver = await waitCDP();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method) {
    events.push(m);
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
await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

await S('Page.navigate', { url: PAGE_URL });

/* ---------------- 等模型加载完 ---------------- */

async function evalJs(expr) {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

let ready = false;
for (let i = 0; i < 120; i++) {
  const v = await evalJs(
    `(() => { const o = document.getElementById('overlay'); return !!(o && !o.classList.contains('show')); })()`
  );
  if (v) { ready = true; break; }
  await sleep(1000);
}
console.log(`模型加载完成：${ready}`);
if (!ready) {
  console.error('模型没加载完，后面的场景截图不可信');
}

await sleep(2500);

/* ---------------- 场景清单 ---------------- */

const presets = await evalJs(`JSON.stringify(window.__garage.viewer.listPresets())`);
const presetsArr = JSON.parse(presets);
console.log(`场景数：${presetsArr.length} → ${presetsArr.map((p) => p.id).join(', ')}`);

/** 每个视角：相机相对车身中心的方向（车头 +X，车宽 Z） */
const ANGLES = [
  { key: 'front', label: '车头', dir: [1, 0.42, 0.28], dist: 7.6 },
  { key: 'rear', label: '车尾', dir: [-1, 0.42, 0.28], dist: 7.6 },
  { key: 'rear-quarter', label: '侧后方', dir: [-0.78, 0.46, 1], dist: 7.8 },
];

async function setCamera(dir, dist) {
  await evalJs(`(() => {
    const g = window.__garage;
    const c = g.viewer.controls.target.clone();
    const d = new g.THREE.Vector3(${dir[0]}, ${dir[1]}, ${dir[2]}).normalize();
    g.viewer.camera.position.copy(c).addScaledVector(d, ${dist});
    g.viewer.controls.update();
    return true;
  })()`);
}

async function shot(path) {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
  return path;
}

/* ---------------- 逐场景截图 ---------------- */

const report = [];
for (const p of presetsArr) {
  await evalJs(`window.__garage.app.setEnvironment(${JSON.stringify(p.id)});`);
  await sleep(900); // 等 PMREM 重建 + 渲染循环出帧

  const lights = JSON.parse(await evalJs(`JSON.stringify(window.__garage.viewer.getLights())`));
  const exposure = await evalJs(`window.__garage.viewer.getExposure()`);
  const shadowCount = lights.filter((l) => l.castShadow).length;
  const back = lights.filter((l) => /背光|轮廓|后方补光/.test(l.role));
  const maxBack = back.reduce((m, l) => Math.max(m, l.intensity), 0);

  const files = [];
  for (const a of ANGLES) {
    await setCamera(a.dir, a.dist);
    await sleep(650);
    const f = `${OUT}/scene-${p.id}-${a.key}.png`;
    await shot(f);
    files.push(f);
  }

  report.push({
    id: p.id,
    label: p.label,
    lights: lights.length,
    shadow: shadowCount,
    backLights: back.length,
    maxBackIntensity: +maxBack.toFixed(2),
    exposure: +Number(exposure).toFixed(2),
    files,
  });

  console.log(
    `\n【${p.id} ${p.label}】 灯 ${lights.length} 盏 / 投影 ${shadowCount} 盏 / 背光类 ${back.length} 盏 最强背光 ${maxBack.toFixed(2)} / 曝光 ${Number(exposure).toFixed(2)}`
  );
  for (const l of lights) {
    console.log(`   · ${l.label.padEnd(6, '　')} ${String(l.intensity.toFixed(2)).padStart(5)}  ${l.role}${l.castShadow ? ' [投影]' : ''}`);
  }
  for (const f of files) console.log(`   → ${f}`);
}

/* ---------------- 错误检查 ---------------- */

const consoleErrors = events
  .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
  .map((e) => e.params.entry.text);
const exceptions = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);

console.log(`\n══════════ 汇总 ══════════`);
console.log(`console.error：${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 10)) console.log(`  ! ${e}`);
console.log(`未捕获异常：${exceptions.length}`);
for (const e of exceptions.slice(0, 10)) console.log(`  ! ${e}`);

let bad = 0;
for (const r of report) {
  if (r.lights < 5) { console.log(`  ✗ ${r.id} 灯数 ${r.lights} < 5`); bad++; }
  if (r.shadow < 2) { console.log(`  ✗ ${r.id} 投影灯 ${r.shadow} < 2`); bad++; }
  if (r.maxBackIntensity < 1.0) { console.log(`  ✗ ${r.id} 最强背光 ${r.maxBackIntensity} < 1.0`); bad++; }
}
console.log(`场景硬性指标不合格数：${bad}`);

fs.writeFileSync(`${OUT}/scene-report.json`, JSON.stringify({ report, consoleErrors, exceptions }, null, 2));
console.log(`\n报告：${OUT}/scene-report.json`);

/* ---------------- 收尾 ---------------- */

await S('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
chrome.kill();
process.exit(bad === 0 && consoleErrors.length === 0 && exceptions.length === 0 ? 0 : 1);
