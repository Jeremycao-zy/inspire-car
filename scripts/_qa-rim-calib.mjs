/**
 * _qa-rim-calib.mjs — 轮毂校准安全网 真实验证（headless Chrome + SwiftShader）
 *
 * 红线：不调用 /api/generate（不耗额度），不跑 _probe-rim-matrix.mjs，不改源码。
 * 仅通过 window.__garage 暴露的 app/rig 读真实 3D 状态做断言。
 */
import puppeteer from '/Users/jeremysmac/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { readFileSync } from 'node:fs';

const EXEC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:5173/';
const TOL_ROT = 0.01;   // rad
const TOL_POS = 0.002;  // m  (±2mm)

const browser = await puppeteer.launch({
  executablePath: EXEC,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-proxy-server', '--proxy-bypass-list=*', '--window-size=1400,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

const results = {};
const step = (name, ok, detail) => { results[name] = { ok, ...detail }; };

try {
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // 进入 TUNING STUDIO
  await page.evaluate(() => {
    if (window.enterTuner) window.enterTuner();
    else if (window.__garage?.enterTuner) window.__garage.enterTuner();
    else window.__garage?.startTuner();
  });

  // 等四轮装配完成
  await page.waitForFunction(() => window.__garage?.rig?.corners?.length === 4, { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 400));

  const readCorners = () => page.evaluate(() => {
    const rig = window.__garage.rig;
    const THREE = window.__garage.THREE;
    return (rig.corners || []).map((c) => {
      const v = new THREE.Vector3();
      c.axle.getWorldPosition(v);
      return {
        id: c.id,
        rotZ: +c.rimRoot.rotation.z.toFixed(5),
        posX: +c.rimRoot.position.x.toFixed(5),
        posY: +c.rimRoot.position.y.toFixed(5),
        posZ: +c.rimRoot.position.z.toFixed(5),
        axleY: +v.y.toFixed(5),
      };
    });
  });

  const setAndApply = (mut) => page.evaluate((mut) => {
    Object.assign(window.__garage.app.params, mut);
    window.__garage.app.apply();
  }, mut);

  // 判断 4 角在某字段上一致 + 满足预期
  const check = (corners, field, expected) => {
    const vals = corners.map((c) => c[field]);
    const spread = Math.max(...vals) - Math.min(...vals);
    const ok = spread < TOL_ROT && vals.every((v) => Math.abs(v - expected) < (field === 'rotZ' ? TOL_ROT : TOL_POS));
    return { vals: vals.map((v) => +v.toFixed(5)), spread: +spread.toFixed(5), expected, ok };
  };
  const allPosZero = (corners) => {
    const okX = corners.every((c) => Math.abs(c.posX) < TOL_POS);
    const okY = corners.every((c) => Math.abs(c.posY) < TOL_POS);
    const okZ = corners.every((c) => Math.abs(c.posZ) < TOL_POS);
    const okR = corners.every((c) => Math.abs(c.rotZ) < TOL_ROT);
    return { okX, okY, okZ, okR, ok: okX && okY && okZ && okR };
  };
  // 仅校验偏移归零（不要求 rotation≈0），用于"旋转"等步骤
  const posOnlyZero = (corners) => {
    const okX = corners.every((c) => Math.abs(c.posX) < TOL_POS);
    const okY = corners.every((c) => Math.abs(c.posY) < TOL_POS);
    const okZ = corners.every((c) => Math.abs(c.posZ) < TOL_POS);
    return { okX, okY, okZ, ok: okX && okY && okZ };
  };

  /* ---- 断言 1：初始状态 ---- */
  {
    const c = await readCorners();
    const p = allPosZero(c);
    step('A1_initial', p.ok, { corners: c.length, rotZ: c.map((x) => x.rotZ), pos: c.map((x) => [x.posX, x.posY, x.posZ]), posZero: p });
  }

  /* ---- 断言 2：旋转 rimSpinDeg=90 ---- */
  {
    await setAndApply({ rimSpinDeg: 90, rimOffsetX: 0, rimOffsetY: 0, rimOffsetZ: 0 });
    await new Promise((r) => setTimeout(r, 150));
    const c = await readCorners();
    const r = check(c, 'rotZ', Math.PI / 2);
    const pz = posOnlyZero(c);
    step('A2_spin90', r.ok && pz.ok, { rotZ: r, posZero: pz, measuredRotZ: c.map((x) => x.rotZ) });
  }

  /* ---- 断言 3：横向 rimOffsetX=20mm ---- */
  {
    await setAndApply({ rimSpinDeg: 0, rimOffsetX: 20, rimOffsetY: 0, rimOffsetZ: 0 });
    await new Promise((r) => setTimeout(r, 150));
    const c = await readCorners();
    const px = check(c, 'posX', 0.020);
    step('A3_offsetX', px.ok, { posX: px, measuredPosX: c.map((x) => x.posX) });
  }

  /* ---- 断言 4：竖向 rimOffsetY=-15mm ---- */
  {
    await setAndApply({ rimSpinDeg: 0, rimOffsetX: 0, rimOffsetY: -15, rimOffsetZ: 0 });
    await new Promise((r) => setTimeout(r, 150));
    const c = await readCorners();
    const py = check(c, 'posY', -0.015);
    step('A4_offsetY', py.ok, { posY: py, measuredPosY: c.map((x) => x.posY) });
  }

  /* ---- 断言 5：轴向 rimOffsetZ=10mm ---- */
  {
    await setAndApply({ rimSpinDeg: 0, rimOffsetX: 0, rimOffsetY: 0, rimOffsetZ: 10 });
    await new Promise((r) => setTimeout(r, 150));
    const c = await readCorners();
    const pz = check(c, 'posZ', 0.010);
    step('A5_offsetZ', pz.ok, { posZ: pz, measuredPosZ: c.map((x) => x.posZ) });
  }

  /* ---- 断言 6：与悬挂共存（suspensionDelta=50） ---- */
  {
    const before = await readCorners();           // step5 状态：rotZ=0, pos≈(0,0,0.010)
    const axleBefore = before.map((x) => x.axleY);
    await setAndApply({ rimSpinDeg: 0, rimOffsetX: 0, rimOffsetY: 0, rimOffsetZ: 0, suspensionDelta: 50 });
    await new Promise((r) => setTimeout(r, 200));
    const after = await readCorners();
    const axleAfter = after.map((x) => x.axleY);
    const fourCorners = after.length === 4;
    const pz = allPosZero(after);                 // 校准值应被本次 apply 保持为 0
    const axleStable = fourCorners && axleBefore.every((y, i) => Math.abs(y - axleAfter[i]) < 1e-4);
    step('A6_susp_coexist', fourCorners && pz.ok && axleStable, {
      corners: after.length,
      rotZ: after.map((x) => x.rotZ),
      pos: after.map((x) => [x.posX, x.posY, x.posZ]),
      axleY_before: axleBefore,
      axleY_after: axleAfter,
      axleStable,
    });
  }

  /* ---- 断言 7：DOM 轮毂校准分组 + 4 个 range 滑杆 ---- */
  {
    const dom = await page.evaluate(() => {
      const h2s = [...document.querySelectorAll('h2.sec-title')];
      const target = h2s.find((h) => h.textContent && h.textContent.includes('轮毂校准'));
      const sec = target ? target.closest('section') : null;
      const ranges = sec ? [...sec.querySelectorAll('input[type=range]')] : [];
      return {
        hasGroup: !!target,
        groupTitle: target ? target.textContent : null,
        rangeCount: ranges.length,
        ranges: ranges.map((i) => ({ id: i.id, name: i.name, min: i.min, max: i.max })),
      };
    });
    // 标题存在 + 4 个滑杆存在 => 结构 pass；id/name 含 key 才算完整 pass
    const structOk = dom.hasGroup && dom.rangeCount === 4;
    const idNameOk = dom.ranges.length === 4 && dom.ranges.every((r) =>
      (r.id && /rimSpinDeg|rimOffsetX|rimOffsetY|rimOffsetZ/.test(r.id)) ||
      (r.name && /rimSpinDeg|rimOffsetX|rimOffsetY|rimOffsetZ/.test(r.name)));
    step('A7_dom', structOk, { hasGroup: dom.hasGroup, groupTitle: dom.groupTitle, rangeCount: dom.rangeCount, idNameOk, ranges: dom.ranges });
  }

  /* ---- 断言 8：生成后状态文案（静态确认 src/main.js） ---- */
  {
    let found = false, snippet = '';
    try {
      const src = readFileSync('/Users/jeremysmac/WorkBuddy/2026-08-27-21-15-16/garage-vite/src/main.js', 'utf8');
      const m = src.match(/生成完成，已装配 4 只[^\x27\x22)]*/);
      found = !!m;
      snippet = m ? m[0] : '';
    } catch (e) { snippet = 'read error: ' + e.message; }
    step('A8_status_text', found, { found, snippet });
  }

  /* ---- 截图 ---- */
  try {
    await page.evaluate(() => {
      const h2s = [...document.querySelectorAll('h2.sec-title')];
      const target = h2s.find((h) => h.textContent && h.textContent.includes('轮毂校准'));
      target?.scrollIntoView({ block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: '/Users/jeremysmac/WorkBuddy/2026-08-27-21-15-16/garage-vite/outputs/qa-rim-calib.png' });
  } catch (e) { results.screenshot = 'FAIL: ' + e.message; }

} catch (e) {
  results.fatal = String(e && e.stack || e);
} finally {
  await browser.close();
}

/* ---- 汇总 ---- */
const list = ['A1_initial', 'A2_spin90', 'A3_offsetX', 'A4_offsetY', 'A5_offsetZ', 'A6_susp_coexist', 'A7_dom', 'A8_status_text'];
const passed = list.filter((k) => results[k]?.ok).length;
const summary = {
  passed, total: list.length, passRate: `${Math.round((passed / list.length) * 100)}%`,
  consoleErrorCount: consoleErrors.length,
  pageErrorCount: pageErrors.length,
};

// 非阻断分类：DEMO GLB 贴图 blob 相关
const noise = (s) => /blob|texture|glb|Failed to load .*texture|image|mime|decode/i.test(s);
const blockingConsole = consoleErrors.filter((e) => !noise(e));
const blockingPage = pageErrors.filter((e) => !noise(e));

const out = {
  summary,
  blockingErrors: { console: blockingConsole, page: blockingPage },
  nonBlockingConsole: consoleErrors.filter(noise),
  results,
};
console.log(JSON.stringify(out, null, 2));
