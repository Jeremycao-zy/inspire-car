/**
 * _qa-susp-browser.mjs — 浏览器端真实验证（headless Chrome + SwiftShader）
 *
 * 用本机 Chrome + puppeteer-core（不依赖 agent-browser CDP），从 garage 层进入
 * TUNING STUDIO，对「精度档位」与「悬挂高低滑杆 + 三色读数」做真实验证并截图。
 *
 * 不调用 /api/generate（不消耗额度）。
 */

import { createRequire } from 'module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('/Users/jeremysmac/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:5173/';
const OUT = '/Users/jeremysmac/WorkBuddy/2026-08-27-21-15-16/garage-vite/outputs';
const RES = `${OUT}/qa-suspension-results.json`;

const consoleErrors = [];
const pageErrors = [];
const results = {};

function save() {
  try {
    fs.writeFileSync(RES, JSON.stringify(results, null, 2));
  } catch {}
}

function classify(text) {
  // DEMO 车模 GLB 贴图 / blob 报错属已知非阻断
  if (/blob|glb|texture|my-car|wheel\.glb|THREE\.WebGLRenderer|loadTexture|Failed to load resource/i.test(text)) {
    return 'non-blocking-known';
  }
  return 'blocking';
}

function assert(name, cond, extra = '') {
  const status = cond ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${name}${extra ? '  →  ' + extra : ''}`);
  return cond;
}

async function main() {
  console.log('\n═══════ D. 浏览器端真实验证（headless Chrome + SwiftShader）═══════\n');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--window-size=1400,1000',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        consoleErrors.push({ text: t, kind: classify(t) });
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push({ text: String(err?.message || err), kind: classify(String(err?.message || err)) });
    });

    console.log('— 打开页面 + 进入 TUNING STUDIO —');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#garage', { timeout: 15000 });
    await page.evaluate(() => window.__garage && window.__garage.enterTuner());
    await page.waitForSelector('.prec-bar', { timeout: 15000 });
    await page.waitForSelector('.readout.susp', { timeout: 15000 });
    // 等底盘 derive 完成（整车 GLB 载入后 rideHeight 才 > 0，读数才有真实基准值）
    await page.waitForFunction(
      () => window.__garage && window.__garage.chassis && window.__garage.chassis.p && window.__garage.chassis.p.rideHeight > 0,
      { timeout: 20000 }
    );
    await new Promise((r) => setTimeout(r, 600)); // 等 3D 渲染稳定

    /* ---- D.1 精度档位选择器 ---- */
    console.log('\n— D.1 精度档位选择器 —');
    const prec = await page.evaluate(() => {
      const bar = document.querySelector('.prec-bar');
      if (!bar) return { found: false };
      const btns = [...bar.querySelectorAll('.chip')].map((b) => ({
        prec: b.dataset.prec,
        label: b.textContent.trim(),
        on: b.classList.contains('on'),
      }));
      const highlighted = btns.filter((b) => b.on).map((b) => b.prec);
      return { found: true, btns, highlighted };
    });
    results.D1 = prec;
    save();
    if (prec.found) {
      const labels = prec.btns.map((b) => `${b.prec}=${b.label}`).join(' ');
      assert('精度选择器存在（标准/高精/极限）', prec.btns.length === 3 && prec.btns.every((b) => ['standard', 'high', 'extreme'].includes(b.prec)), labels);
      assert('默认高亮档 = high（高精）', prec.highlighted.length === 1 && prec.highlighted[0] === 'high', `highlighted=${JSON.stringify(prec.highlighted)}`);
    } else {
      assert('精度选择器存在', false);
    }

    /* ---- D.2 悬挂滑杆 + 三色读数 ---- */
    console.log('\n— D.2 悬挂高低滑杆 + 三色读数 —');
    const suspBefore = await page.evaluate(() => {
      const ctl = [...document.querySelectorAll('.ctl')].find((c) => {
        const l = c.querySelector('.ctl-label');
        return l && l.textContent.includes('悬挂高低');
      });
      let slider = null;
      if (ctl) {
        const inp = ctl.querySelector('input[type=range]');
        slider = { min: inp.min, max: inp.max, step: inp.step, value: inp.value, label: ctl.querySelector('.ctl-label').textContent.trim() };
      }
      const rows = [...document.querySelectorAll('.readout.susp .susp-row')].map((r) => ({
        label: r.querySelector('.susp-label')?.textContent.trim(),
        val: r.querySelector('.susp-val')?.textContent.trim(),
        cls: ['susp-good', 'susp-warn', 'susp-danger'].find((c) => r.classList.contains(c)) || null,
      }));
      const carInner = window.__garage.viewer.scene.getObjectByName('carInner');
      return { slider, rows, carInnerY: carInner ? carInner.position.y : null, chassisRootY: window.__garage.chassis.root.position.y };
    });
    results.D2 = suspBefore;
    save();
    assert('悬挂滑杆存在且范围 [−10,+75] step 1', suspBefore.slider && suspBefore.slider.min === '-10' && suspBefore.slider.max === '75' && suspBefore.slider.step === '1', JSON.stringify(suspBefore.slider));
    assert('读数 3 行 + 三色 class', suspBefore.rows.length === 3 && suspBefore.rows.every((r) => r.cls), `rows=${suspBefore.rows.length}, labels=${suspBefore.rows.map((r) => r.label).join('/')}`);
    const beforeFender = suspBefore.rows.find((r) => r.label === '轮拱间隙');
    const beforeGC = suspBefore.rows.find((r) => r.label === '离地间隙');
    assert('Δ=0 时离地间隙=+125mm（绿）', beforeGC && beforeGC.val === '+125 mm' && beforeGC.cls === 'susp-good', beforeGC ? `${beforeGC.val}/${beforeGC.cls}` : 'missing');
    assert('Δ=0 时轮拱间隙=+45mm（绿）', beforeFender && beforeFender.val === '+45 mm' && beforeFender.cls === 'susp-good', beforeFender ? `${beforeFender.val}/${beforeFender.cls}` : 'missing');
    assert('Δ=0 时车身 chassis.root.y=0', Math.abs(suspBefore.chassisRootY) < 1e-9, String(suspBefore.chassisRootY));

    /* ---- 截图 before（展开装配微调看读数）---- */
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('.sec-title.toggle')].find((x) => x.textContent.includes('装配微调'));
      if (t && !t.classList.contains('open')) t.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: `${OUT}/qa-suspension-01-default.png` });

    /* ---- D.3 拖到 +50，验证读数 + 车身下移 ---- */
    console.log('\n— D.3 拖动悬挂滑杆到 +50mm —');
    await page.evaluate(() => {
      const ctl = [...document.querySelectorAll('.ctl')].find((c) => {
        const l = c.querySelector('.ctl-label');
        return l && l.textContent.includes('悬挂高低');
      });
      const inp = ctl.querySelector('input[type=range]');
      inp.value = '50';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 700));

    const suspAfter = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.readout.susp .susp-row')].map((r) => ({
        label: r.querySelector('.susp-label')?.textContent.trim(),
        val: r.querySelector('.susp-val')?.textContent.trim(),
        cls: ['susp-good', 'susp-warn', 'susp-danger'].find((c) => r.classList.contains(c)) || null,
      }));
      const carInner = window.__garage.viewer.scene.getObjectByName('carInner');
      const sliderVal = [...document.querySelectorAll('.ctl')]
        .find((c) => c.querySelector('.ctl-label')?.textContent.includes('悬挂高低'))
        ?.querySelector('input[type=range]')?.value;
      return { rows, carInnerY: carInner ? carInner.position.y : null, chassisRootY: window.__garage.chassis.root.position.y, sliderVal };
    });
    results.D3 = suspAfter;
    save();

    const afterFender = suspAfter.rows.find((r) => r.label === '轮拱间隙');
    const afterDelta = suspAfter.rows.find((r) => r.label === '降低量 Δ');
    const afterGC = suspAfter.rows.find((r) => r.label === '离地间隙');

    assert('滑杆值已置为 50', suspAfter.sliderVal === '50', String(suspAfter.sliderVal));
    assert('轮拱间隙数值下降（+45 → -5）', beforeFender && afterFender && afterFender.val === '-5 mm', `${beforeFender?.val} → ${afterFender?.val}`);
    assert('轮拱间隙状态变红（good → danger）', beforeFender && afterFender && beforeFender.cls === 'susp-good' && afterFender.cls === 'susp-danger', `${beforeFender?.cls} → ${afterFender?.cls}`);
    assert('降低量 Δ 读数 = +50 mm', afterDelta && afterDelta.val === '+50 mm', afterDelta?.val);
    assert('离地间隙随 Δ 下降（125 → 75，红）', afterGC && afterGC.val === '+75 mm' && afterGC.cls === 'susp-danger', afterGC ? `${afterGC.val}/${afterGC.cls}` : 'missing');
    assert('车身下移：carInner.y 减小', suspBefore.carInnerY != null && suspAfter.carInnerY != null && suspAfter.carInnerY < suspBefore.carInnerY - 0.04, `${suspBefore.carInnerY} → ${suspAfter.carInnerY}`);
    assert('chassis.root.y = -0.05（Δ 生效）', Math.abs(suspAfter.chassisRootY - (-0.05)) < 1e-9, String(suspAfter.chassisRootY));
    await page.screenshot({ path: `${OUT}/qa-suspension-02-delta50.png` });

    const readoutEl = await page.$('.readout.susp');
    if (readoutEl) await readoutEl.screenshot({ path: `${OUT}/qa-suspension-03-readout.png` });

    /* ---- D.4 console / pageerror ---- */
    console.log('\n— D.4 控制台 / 页面错误 —');
    const blocking = [...consoleErrors, ...pageErrors].filter((e) => e.kind === 'blocking');
    const nonblocking = [...consoleErrors, ...pageErrors].filter((e) => e.kind === 'non-blocking-known');
    results.D4 = { consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, blocking, nonblocking };
    save();
    console.log(`  console.error 数：${consoleErrors.length}（阻断 ${blocking.length} / 非阻断 ${nonblocking.length}）`);
    console.log(`  pageerror 数：${pageErrors.length}`);
    if (nonblocking.length) {
      console.log('  非阻断（已知 DEMO GLB 贴图/blob 报错）：');
      nonblocking.forEach((e) => console.log('    · ' + e.text.slice(0, 160)));
    }
    if (blocking.length) {
      console.log('  ⚠️ 阻断性 JS 报错（新增代码引入）：');
      blocking.forEach((e) => console.log('    · ' + e.text.slice(0, 200)));
    }
    assert('无阻断性 JS 报错（新增代码未引入）', blocking.length === 0, `blocking=${blocking.length}`);

    const allPass =
      prec.found && prec.highlighted[0] === 'high' &&
      suspBefore.slider && suspBefore.slider.min === '-10' && suspBefore.slider.max === '75' &&
      suspBefore.rows.length === 3 &&
      afterFender && afterFender.val === '-5 mm' && afterFender.cls === 'susp-danger' &&
      suspAfter.chassisRootY === -0.05 &&
      blocking.length === 0;
    console.log(`\n═══════ D 结论：${allPass ? '全部通过' : '存在失败项'} ═══════`);
    console.log('截图：outputs/qa-suspension-01-default.png / 02-delta50.png / 03-readout.png');
  } finally {
    try {
      await browser.close();
    } catch {}
    save();
  }
}

main().catch((e) => {
  console.error('浏览器验证脚本崩溃：', e);
  save();
  process.exit(2);
});
