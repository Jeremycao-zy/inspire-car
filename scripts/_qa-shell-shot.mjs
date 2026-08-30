/**
 * _qa-shell-shot.mjs — 车壳 / 底盘视觉自检（临时脚本，前缀 _，非产物）
 *
 * 在 headless Chrome 里截三类图，证明「贴图上画的轮子已经看不见了」：
 *   1. 车壳三道切割后：底视 / 侧视 / 45°
 *   2. 底盘 + 轮子装上去的整体效果：iso / 正侧 / 正前 / 正后
 *   3. 四个轮拱特写
 *
 * 同时把关键状态用 Runtime.evaluate 抓出来打印（切割面数、底盘面数、
 * 局部可见性、控制台错误），因为截图本身只能人工看，指标要能进回归。
 *
 * 用法：node scripts/_qa-shell-shot.mjs [port]
 */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.argv[2] || 9555);
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
    `--user-data-dir=/tmp/chrome-shell-${PORT}`,
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
  width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
});
await S('Page.navigate', { url: PAGE_URL });

async function evalJs(expr) {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function shot(path) {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
  return path;
}

/** 把相机放到指定方向（相对车身中心） */
async function cam(dir, dist) {
  await evalJs(`(() => {
    const g = window.__garage;
    const c = g.viewer.controls.target.clone();
    const d = new g.THREE.Vector3(${dir[0]}, ${dir[1]}, ${dir[2]}).normalize();
    g.viewer.camera.position.copy(c).addScaledVector(d, ${dist});
    g.viewer.controls.update();
    return true;
  })()`);
  await sleep(600);
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

/* ---------------- 状态抓取 ---------------- */
const state = JSON.parse(await evalJs(`(() => {
  const g = window.__garage;
  const cs = g.chassis.p;
  const sc = g.shellCutter.stats();
  return JSON.stringify({
    preset: g.viewer.getPresetId(),
    bodyHalfWidth: g.shellMetrics.current ? g.shellMetrics.current.bodyHalfWidth : null,
    shell: sc,
    chassisTris: g.chassis.triCount(),
    chassisMeshes: g.chassis.parts.length,
    params: {
      wheelbase: cs.wheelbase, axleX_F: cs.axleX_F, axleX_R: cs.axleX_R,
      halfTrack_F: cs.halfTrack_F, halfTrack_R: cs.halfTrack_R,
      hubY_F: cs.hubY_F, hubY_R: cs.hubY_R,
      deckHeight: cs.deckHeight, clipZ: cs.clipZ, clipTopY: cs.clipTopY,
      archR_F: cs.archR_F, archR_R: cs.archR_R, shellLift: cs.shellLift,
    },
    corners: g.chassis.cornerSpec().corners.map(c => ({ id: c.id, x: +c.x.toFixed(4), y: +c.y.toFixed(4), z: +c.z.toFixed(4) })),
    rigLive: Object.fromEntries(Object.entries(g.rig.live).map(([k,v]) => [k, { x:+v.x.toFixed(4), y:+v.y.toFixed(4), z:+v.z.toFixed(4), r:+v.r.toFixed(4) }])),
    wheelMeshes: (() => { let n=0; g.rig.root.traverse(o => { if (o.isMesh) n++; }); return n; })(),
    brand: {
      sidebar: !!document.querySelector('.jg-brand--sidebar'),
      watermark: !!document.querySelector('.jg-brand--watermark'),
    },
  });
})()`));

console.log('\n── 运行时状态 ──');
console.log(`  场景预设 = ${state.preset}`);
console.log(`  车身半宽 = ${state.bodyHalfWidth}`);
console.log(`  车壳切割 = ${state.shell.removedTris.toLocaleString()} / ${state.shell.totalTris.toLocaleString()}（${((state.shell.removedTris / state.shell.totalTris) * 100).toFixed(2)}%）  重建次数 ${state.shell.buildCount}`);
console.log(`  底盘 = ${state.chassisTris.toLocaleString()} 面 / ${state.chassisMeshes} mesh`);
console.log(`  品牌标识：侧栏 ${state.brand.sidebar ? '✅' : '❌'}  水印 ${state.brand.watermark ? '✅' : '❌'}`);
console.log(`  轮位（底盘 cornerSpec）：`);
for (const c of state.corners) console.log(`    ${c.id}  (${c.x}, ${c.y}, ${c.z})`);
console.log(`  轮位（rig.live，含 ET 偏移）：`);
for (const [k, v] of Object.entries(state.rigLive)) console.log(`    ${k}  (${v.x}, ${v.y}, ${v.z})  R=${v.r}`);

/* ---------------- 1. 车壳切割后（隐藏底盘与车轮） ---------------- */
console.log('\n── 截图 1：车壳三道切割后（隐藏底盘 + 车轮）──');
await evalJs(`(() => {
  const g = window.__garage;
  g.chassis.setVisible(false);
  g.rig.root.visible = false;
  return true;
})()`);
await sleep(500);
const shellShots = [
  ['shell-bottom', [0.05, -1, 0.12], 8.0],
  ['shell-side', [0.02, 0.22, 1], 9.0],
  ['shell-iso', [0.72, 0.34, 0.9], 9.0],
];
for (const [name, dir, dist] of shellShots) {
  await cam(dir, dist);
  await shot(`${OUT}/shell-${name}.png`);
  console.log(`  → ${OUT}/shell-${name}.png`);
}

/* ---------------- 2. 底盘 + 轮子整体 ---------------- */
console.log('\n── 截图 2：车壳 + 底盘 + 车轮 整体 ──');
await evalJs(`(() => {
  window.__garage.chassis.setVisible(true);
  window.__garage.rig.root.visible = true;
  return true;
})()`);
await sleep(700);
const fullShots = [
  ['full-iso', [0.72, 0.34, 0.9], 9.0],
  ['full-side', [0.02, 0.22, 1], 9.0],
  ['full-front', [1, 0.3, 0.06], 8.4],
  ['full-rear', [-1, 0.32, 0.06], 8.4],
  ['full-low45', [0.8, 0.12, 0.85], 8.2],
];
for (const [name, dir, dist] of fullShots) {
  await cam(dir, dist);
  await shot(`${OUT}/shell-${name}.png`);
  console.log(`  → ${OUT}/shell-${name}.png`);
}

/* ---------------- 3. 轮拱特写 ---------------- */
console.log('\n── 截图 3：四个轮拱特写 ──');
const CORNERS = [
  ['FL', [0.62, 0.34, 0.9]],
  ['FR', [0.62, 0.34, -0.9]],
  ['RL', [-0.62, 0.34, 0.9]],
  ['RR', [-0.62, 0.34, -0.9]],
];
for (const [cid, dir] of CORNERS) {
  await evalJs(`(() => {
    const g = window.__garage;
    const c = g.chassis.cornerSpec().corners.find(x => x.id === ${JSON.stringify(cid)});
    const p = new g.THREE.Vector3(c.x, c.y, c.z);
    g.viewer.controls.target.copy(p);
    const d = new g.THREE.Vector3(${dir[0]}, ${dir[1]}, ${dir[2]}).normalize();
    g.viewer.camera.position.copy(p).addScaledVector(d, 2.3);
    g.viewer.controls.update();
    return true;
  })()`);
  await sleep(650);
  await shot(`${OUT}/shell-arch-${cid}.png`);
  console.log(`  → ${OUT}/shell-arch-${cid}.png`);
}

/* ---------------- 4. 各场景下的整体（证明背光面看得清） ---------------- */
console.log('\n── 截图 4：六场景整体（iso + 侧后方）──');
const presets = JSON.parse(await evalJs(`JSON.stringify(window.__garage.viewer.listPresets())`));
for (const p of presets) {
  await evalJs(`window.__garage.app.setEnvironment(${JSON.stringify(p.id)});`);
  await sleep(900);
  await cam([0.72, 0.34, 0.9], 9.0);
  await shot(`${OUT}/shell-scene-${p.id}-iso.png`);
  await cam([-0.78, 0.46, 1], 8.4);
  await shot(`${OUT}/shell-scene-${p.id}-rq.png`);
  console.log(`  → shell-scene-${p.id}-{iso,rq}.png`);
}

/* ---------------- 错误检查 ---------------- */
const consoleErrors = events
  .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
  .map((e) => `${e.params.entry.text} ${e.params.entry.url || ''}`);
const exceptions = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);

console.log(`\n══════════ 汇总 ══════════`);
console.log(`console.error：${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 10)) console.log(`  ! ${e}`);
console.log(`未捕获异常：${exceptions.length}`);
for (const e of exceptions.slice(0, 10)) console.log(`  ! ${e}`);

fs.writeFileSync(`${OUT}/shell-qa-report.json`, JSON.stringify({ state, consoleErrors, exceptions }, null, 2));
console.log(`\n报告：${OUT}/shell-qa-report.json`);

await S('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
chrome.kill();
process.exit(exceptions.length === 0 ? 0 : 1);
