/**
 * _qa-e2e-cdp.mjs — 浏览器端到端验证（严过关 / QA 独立）
 *
 * 通过 Chrome DevTools Protocol 驱动 headless Chrome 打开真实页面，
 * 捕获三类证据：
 *   ① alert 弹窗（Bug 现象就是「整车模型载入失败：…」的 alert）
 *   ② 未捕获异常 / console.error
 *   ③ 加载完成后 rig 的真实运行状态（corners 数、轮胎几何是否合法）
 *
 * 依赖：本机 Chrome + Node 22 内置全局 WebSocket，无需 puppeteer。
 * 前置：dev 服务已在 127.0.0.1:5173 运行；Chrome 已带 --remote-debugging-port=9222 启动。
 */

const CDP_HTTP = 'http://127.0.0.1:9222';
const PAGE_URL = 'http://127.0.0.1:5173/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端 */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  return {
    send(method, params = {}) {
      const mid = ++id;
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    on(fn) {
      listeners.push(fn);
    },
    close: () => ws.close(),
  };
}

const alerts = [];
const exceptions = [];
const consoleErrors = [];

async function main() {
  // 新建一个标签页
  const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const tab = await (
    await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  const cdp = await attach(tab.webSocketDebuggerUrl);

  cdp.on((msg) => {
    if (msg.method === 'Page.javascriptDialogOpening') {
      alerts.push(msg.params.message);
      // 自动点掉 alert，避免页面卡死
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      exceptions.push(d.exception?.description || d.text || String(msg.params));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry?.level === 'error') {
      consoleErrors.push(`[${msg.params.entry.source}] ${msg.params.entry.text}`);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  console.log(`▶ 打开 ${PAGE_URL} （Chrome ${ver.Browser}）`);
  await cdp.send('Page.navigate', { url: PAGE_URL });

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };

  // 轮询等待装配完成：四角就位 + 前后轮胎几何都建好
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      ready = await evalJs(
        `!!(window.__garage && window.__garage.rig.corners.length === 4 &&
            window.__garage.rig._tireGeo?.front?.isBufferGeometry &&
            window.__garage.rig._tireGeo?.rear?.isBufferGeometry)`
      );
    } catch {
      /* 页面还在初始化，继续等 */
    }
    if (ready) break;
  }
  console.log(ready ? '✓ 四轮装配完成（corners=4，前后轮胎几何均已建好）' : '✗ 等待装配超时');

  // 再多等一会儿，让 44MB 整车 + 29MB 轮毂 GLB 全部加载完并跑完 boot()
  await sleep(25000);

  let snap = null;
  let snapErr = null;
  try {
    snap = await evalJs(`(() => {
    const { rig, app } = window.__garage;
    const geoms = rig.corners.map(c => ({
      id: c.id,
      type: c.tireMesh.geometry?.type ?? null,
      isBufferGeometry: c.tireMesh.geometry?.isBufferGeometry === true,
      verts: c.tireMesh.geometry?.attributes?.position?.count ?? 0,
      visible: c.tireMesh.visible,
    }));
    return {
      corners: rig.corners.length,
      showTire: app.params.showTire,
      tireGeoFront: rig._tireGeo?.front?.type ?? null,
      tireGeoRear: rig._tireGeo?.rear?.type ?? null,
      geoms,
      live: rig.live,
      wheelSourceName: rig.wheelSource?.name ?? null,
      canvas: !!document.querySelector('canvas'),
    };
  })()`);
  } catch (e) {
    snapErr = e.message;
  }

  // 无论快照成功与否，都先打印诊断信息
  let probe = null;
  try {
    probe = await evalJs(`({
      hasGarage: typeof window.__garage !== 'undefined',
      readyState: document.readyState,
      bodyText: (document.body?.innerText || '').slice(0, 400),
      canvas: !!document.querySelector('canvas'),
      modules: performance.getEntriesByType('resource')
        .filter(r => /\\.js$|\\.glb$/.test(r.name))
        .map(r => r.name.replace(location.origin, '') + ' ' + Math.round(r.duration) + 'ms'),
    })`);
  } catch (e) {
    probe = { error: e.message };
  }

  console.log('\n── 页面探测 ──');
  console.log(JSON.stringify(probe, null, 2));
  if (snapErr) console.log(`\n[快照失败] ${snapErr}`);

  console.log('\n── 捕获到的 alert ──');
  console.log(alerts.length ? alerts.map((a) => `  ⚠ ${a}`).join('\n') : '  （无）');
  console.log('\n── 捕获到的未捕获异常 ──');
  console.log(exceptions.length ? exceptions.map((e) => `  ⚠ ${e.split('\n')[0]}`).join('\n') : '  （无）');
  console.log('\n── 捕获到的 console/log error ──');
  console.log(consoleErrors.length ? consoleErrors.map((e) => `  ⚠ ${e}`).join('\n') : '  （无）');

  const bugSig = /morphAttributes|Cannot convert undefined or null to object|整车模型载入失败/;
  const hitBug =
    alerts.some((a) => bugSig.test(a)) ||
    exceptions.some((e) => bugSig.test(e)) ||
    consoleErrors.some((e) => bugSig.test(e));

  const geoBad = snap ? snap.geoms.filter((g) => !g.isBufferGeometry) : [{ id: '未知（快照失败）' }];

  console.log('\n═══ 端到端结论 ═══');
  console.log(`  Bug 签名命中 : ${hitBug ? '是 ✗' : '否 ✓'}`);
  console.log(`  alert 数量   : ${alerts.length} ${alerts.length ? '✗' : '✓'}`);
  console.log(`  未捕获异常   : ${exceptions.length} ${exceptions.length ? '✗' : '✓'}`);
  console.log(`  非法几何轮数 : ${geoBad.length} ${geoBad.length ? '✗' : '✓'}`);
  console.log(`  四轮顶点数   : ${snap ? snap.geoms.map((g) => g.verts).join(', ') : 'N/A'}`);
  console.log(`  canvas 存在  : ${probe?.canvas ? '✓' : '✗'}`);

  await fetch(`${CDP_HTTP}/json/close/${tab.id}`);
  cdp.close();

  const okAll =
    !hitBug && alerts.length === 0 && exceptions.length === 0 && geoBad.length === 0 && snap && probe?.canvas;
  console.log(okAll ? '\n✅ 浏览器端到端通过：无 alert、无异常、四轮几何合法\n' : '\n❌ 浏览器端到端存在问题\n');
  process.exit(okAll ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 驱动失败：', e);
  process.exit(2);
});
