/** 临时：从浏览器里抓出切割 plan 与世界坐标分布，定位切除率异常 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.argv[2] || 9777);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { spawn } = await import('node:child_process');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-proxy-server', '--no-sandbox',
  '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--window-size=1280,800',
  `--user-data-dir=/tmp/chrome-dbg2-${PORT}`, 'about:blank',
], { stdio: 'ignore' });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch {}
  await sleep(500);
}
const ver = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const { r, j } = pend.get(m.id); pend.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
};
const send = (method, params = {}) => new Promise((r, j) => { const mid = ++id; pend.set(mid, { r, j }); ws.send(JSON.stringify({ id: mid, method, params })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params = {}) => new Promise((r, j) => { const mid = ++id; pend.set(mid, { r, j }); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
const E = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};

await S('Runtime.enable');
await S('Page.enable');
await S('Page.navigate', { url: 'http://127.0.0.1:5173/' });

for (let i = 0; i < 150; i++) {
  const v = await E(`(() => { const o=document.getElementById('overlay'); return !!(o && !o.classList.contains('show')); })()`);
  if (v) break;
  await sleep(1000);
}
await sleep(3000);

const out = await E(`(() => {
  const g = window.__garage;
  const plan = g.chassis.cutPlan();
  const e = g.shellCutter.entries[0];
  const wp = e.world;
  const N = Math.floor(e.orig.count / 3);

  // 世界坐标分布
  let yMin=Infinity,yMax=-Infinity,zMax=0;
  const cy = [];
  for (let t = 0; t < N; t++) {
    const a=e.orig.array[t*3], b=e.orig.array[t*3+1], c=e.orig.array[t*3+2];
    const y=(wp[a*3+1]+wp[b*3+1]+wp[c*3+1])/3;
    const z=Math.abs((wp[a*3+2]+wp[b*3+2]+wp[c*3+2])/3);
    if(y<yMin)yMin=y; if(y>yMax)yMax=y; if(z>zMax)zMax=z;
    cy.push([ (wp[a*3]+wp[b*3]+wp[c*3])/3, y, z ]);
  }
  const c1 = cy.filter(p=>p[1] < plan.deckHeight).length;
  const c2 = cy.filter(p=>p[2] > plan.clipZ && p[1] < plan.clipTopY).length;
  const c3 = cy.filter(p=>{
    for (const a of plan.arches) {
      if (p[2] <= a.innerZ) continue;
      const dx=p[0]-a.axleX, dy=p[1]-a.hubY;
      if (dx*dx+dy*dy < a.radius*a.radius) return true;
    }
    return false;
  }).length;
  const un = cy.filter(p=>{
    if (p[1] < plan.deckHeight) return true;
    if (p[2] > plan.clipZ && p[1] < plan.clipTopY) return true;
    for (const a of plan.arches) {
      if (p[2] <= a.innerZ) continue;
      const dx=p[0]-a.axleX, dy=p[1]-a.hubY;
      if (dx*dx+dy*dy < a.radius*a.radius) return true;
    }
    return false;
  }).length;

  // 与 Node 的 _pct.mjs 分层表对照（判断到底是分布变了还是计数错了）
  const bins = [];
  const edges = [0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.9, 1.4];
  for (let i = 0; i < edges.length - 1; i++) {
    let n = 0;
    let mz = 0;
    for (const p of cy) {
      if (p[1] < edges[i] || p[1] >= edges[i + 1]) continue;
      n++;
      if (p[2] > mz) mz = p[2];
    }
    bins.push([edges[i] + '-' + edges[i + 1], n, +mz.toFixed(4)]);
  }

  return JSON.stringify({
    plan,
    stats: g.shellCutter.stats(),
    world: { yMin:+yMin.toFixed(4), yMax:+yMax.toFixed(4), zMax:+zMax.toFixed(4) },
    counts: { N, c1, c2, c3, union: un },
    bins,
    carInnerY: g.app && document ? null : null,
    baseShellY: g.app._baseShellY,
    lastShellLift: g.app._lastShellLift,
    chassisP: {
      carLength: g.chassis.p.carLength, bodyHalfWidth: g.chassis.p.bodyHalfWidth,
      deckHeight: g.chassis.p.deckHeight, clipZ: g.chassis.p.clipZ, clipTopY: g.chassis.p.clipTopY,
      hubY_F: g.chassis.p.hubY_F, archR_F: g.chassis.p.archR_F, archInnerZ_F: g.chassis.p.archInnerZ_F,
      shellLift: g.chassis.p.shellLift,
    },
    carInnerPosY: (() => { let v=null; g.viewer.scene.traverse(o=>{ if(o.name==='carInner') v=o.position.y; }); return v; })(),
    carOuterPosY: (() => { let v=null; g.viewer.scene.traverse(o=>{ if(o.name==='carOuter') v=o.position.y; }); return v; })(),
  });
})()`);

console.log(out);
ws.close();
chrome.kill();
process.exit(0);
