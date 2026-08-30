/**
 * _qa-after-cut.mjs — 删除「轮毂切割（WheelCutout）」后的回归验证
 * 检查：面板无"原车轮切除"、app.cutout 不存在、4 轮仍双面可见、
 *       ShellCutter（车壳三道切割）仍生效、无 console 错误 / 未捕获异常。
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_HTTP_PORT = 9341;
const CDP_HTTP = `http://127.0.0.1:${CDP_HTTP_PORT}`;
const PAGE_URL = 'http://127.0.0.1:5173/';

const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_HTTP_PORT}`,
  '--no-proxy-server', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', '--window-size=1440,900',
  `--user-data-dir=/tmp/chrome-aftercut-${CDP_HTTP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

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
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: PAGE_URL });

async function evalJs(expr) {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

// 1) 等车库加载（overlay 隐藏）
let ready = false;
for (let i = 0; i < 60; i++) {
  const v = await evalJs(`(() => { const o = document.getElementById('overlay'); return !!(o && !o.classList.contains('show')); })()`);
  if (v) { ready = true; break; }
  await sleep(1000);
}
const garageVisible = await evalJs(`(() => { const g = document.getElementById('garage'); return !!g && !g.classList.contains('hidden'); })()`);
const cardCount = await evalJs(`document.querySelectorAll('.garage-card').length`);
console.log(`车库加载完成：${ready} 可见=${garageVisible} 卡片数=${cardCount}`);

// 2) 进入第一个方案
const clicked = await evalJs(`(() => { const c = document.querySelector('.garage-card'); if (c) c.click(); return !!c; })()`);
console.log('点击进入方案:', clicked);
// 3) 等整车载入（carGroup + shellCutter.entries）
let carReady = false;
for (let i = 0; i < 120; i++) {
  const v = await evalJs(`(() => { const g = window.__garage; return !!(g && g.app && g.app.params && g.shellCutter && g.shellCutter.entries.length > 0); })()`);
  if (v) { carReady = true; break; }
  await sleep(1000);
}
await sleep(2000);

// 4) 采集断言
const checks = await evalJs(`(() => {
  const g = window.__garage;
  const out = {};
  out.hasGarageDebug = !!g;
  out.cutoutOnDebug = g ? (typeof g.cutout) : 'no-garage';
  out.appCutout = g && g.app ? (typeof g.app.cutout) : 'n/a';
  out.corners = g && g.rig ? g.rig.corners.length : -1;
  out.wheelDoubleSide = (() => {
    if (!g || !g.rig) return 'n/a';
    let all = true; let any = false;
    for (const c of g.rig.corners) {
      const root = c.rimRoot || c.model;
      if (!root) return 'no-root';
      root.traverse((o) => { if (o.isMesh) { any = true; if (o.material && o.material.side !== 2) all = false; } });
    }
    return any ? (all ? 'all-doubleside' : 'some-frontside') : 'no-mesh';
  })();
  out.shellEntries = g && g.shellCutter ? g.shellCutter.entries.length : -1;
  out.shellRemovedTris = g && g.shellCutter ? (g.shellCutter.stats().removedTris) : -1;
  out.shellDoubleSide = g && g.shellCutter ? (g.shellCutter.entries.every(e => e.work && true)) : false;
  return JSON.stringify(out);
})()`);
const c = JSON.parse(checks);

// 5) UI 残留检查（面板 DOM）
const ui = await evalJs(`(() => {
  const txt = document.body.innerText || '';
  return JSON.stringify({
    hasCutPanel: /原车轮切除/.test(txt),
    hasCutRadius: /切割半径/.test(txt),
    panelTitle: (document.querySelector('.panel-head h1') || {}).textContent || '',
  });
})()`);
const uiRes = JSON.parse(ui);

// 截图存档
await S('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('/tmp/aftercut-tuner.png', Buffer.from(r.data, 'base64')));

// 6) 错误
const consoleErrors = events.filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error').map((e) => e.params.entry.text);
const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);

console.log('\n═══════ 断言结果 ═══════');
console.log('cutout 调试属性:', c.cutoutOnDebug, '| app.cutout:', c.appCutout);
console.log('车轮数(corners):', c.corners, '| 轮毂材质:', c.wheelDoubleSide);
console.log('车壳切割 entries:', c.shellEntries, '| 切除面数:', c.shellRemovedTris);
console.log('UI 残留 原车轮切除:', uiRes.hasCutPanel, '| 切割半径:', uiRes.hasCutRadius, '| 面板标题:', uiRes.panelTitle);
console.log('console.error:', consoleErrors.length, '| 未捕获异常:', exceptions.length);

const pass =
  c.cutoutOnDebug === 'undefined' &&
  c.appCutout === 'undefined' &&
  c.corners === 4 &&
  c.wheelDoubleSide === 'all-doubleside' &&
  c.shellEntries > 0 &&
  c.shellRemovedTris > 0 &&
  !uiRes.hasCutPanel && !uiRes.hasCutRadius &&
  consoleErrors.length === 0 && exceptions.length === 0;

console.log('\n总判定:', pass ? '✅ PASS' : '❌ FAIL');
if (consoleErrors.length) console.log('  errors:', consoleErrors.slice(0, 5));
if (exceptions.length) console.log('  ex:', exceptions.slice(0, 5));

await S('Target.closeTarget', { targetId }).catch(() => {});
ws.close(); chrome.kill();
process.exit(pass ? 0 : 1);
