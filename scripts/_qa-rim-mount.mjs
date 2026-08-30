import puppeteer from '/Users/jeremysmac/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const EXEC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:5173/';

const browser = await puppeteer.launch({
  executablePath: EXEC, headless: 'new',
  args: ['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--window-size=1400,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

// 进入 TUNING STUDIO（garage 层 enterTuner）
await page.evaluate(() => { if (window.enterTuner) window.enterTuner(); else if (window.__garage?.startTuner) window.__garage.startTuner(); });
// 等整车载入（carGroup 存在）且默认轮 GLB 加载完（rig.corners === 4）
await page.waitForFunction(() => window.__garage?.app?.carGroup, { timeout: 40000 }).catch(()=>{});
await page.waitForFunction(() => window.__garage?.rig?.corners?.length === 4, { timeout: 40000 }).catch(()=>{});

const snap = async (tag) => page.evaluate((tag) => {
  const g = window.__garage; const rig = g.rig; const app = g.app;
  const corners = (rig.corners || []).map(c => {
    const wp = new g.THREE.Vector3(); c.axle && c.axle.getWorldPosition(wp);
    const rr = c.rimRoot;
    let meshCount = 0; if (rr) rr.traverse(o => { if (o.isMesh) meshCount++; });
    return {
      id: c.id, side: c.side,
      rimChildren: rr ? rr.children.length : -1,
      rimHasMesh: meshCount > 0,
      scale: rr ? [rr.scale.x, rr.scale.y, rr.scale.z].map(n=>+n.toFixed(3)) : null,
      world: [+wp.x.toFixed(3), +wp.y.toFixed(3), +wp.z.toFixed(3)],
    };
  });
  return { tag, cornersLen: (rig.corners||[]).length, corners, wheelSource: !!rig.wheelSource, hasCarGroup: !!app?.carGroup };
}, tag);

const boot = await snap('boot(默认车+默认轮)');

// 模拟"生成轮毂"后装车：与 runGenerate 同路
await page.evaluate(() => window.__garage.app.loadWheelFromUrl('/models/wheel.glb'));
await new Promise(r => setTimeout(r, 1500));
const afterGen = await snap('after loadWheelFromUrl(模拟生成装车)');

// 叠加悬挂 +50mm（车身降，车轮不动）
await page.evaluate(() => { window.__garage.app.params.suspensionDelta = 50; window.__garage.app.apply(); });
await new Promise(r => setTimeout(r, 300));
const afterSusp = await snap('after suspension +50');

// 叠加 ET/J 改变（前轮 ET 调小、J 调大）
await page.evaluate(() => {
  const p = window.__garage.app.params;
  p.front.et = 20; p.front.j = 10.5;
  window.__garage.app.apply();
});
await new Promise(r => setTimeout(r, 300));
const afterFit = await snap('after ET/J change');

// 模拟"再生成一辆整车"（车身生成与轮毂并存）
await page.evaluate(() => window.__garage.app.loadCarFromUrl('/models/my-car.glb'));
await new Promise(r => setTimeout(r, 2000));
const afterCar = await snap('after reload car (车身+轮毂并存)');

await browser.close();

// 判定
const fourRims = (s) => s.corners.length === 4 && s.corners.every(c => c.rimChildren >= 1 && c.rimHasMesh);
const distinct = (s) => {
  const ws = s.corners.map(c => c.world.join(','));
  return new Set(ws).size === 4;
};
const report = {
  pageErrors: errs,
  boot: { ok: fourRims(boot), distinct: distinct(boot), fourRims: fourRims(boot) },
  afterGen: { ok: fourRims(afterGen), distinct: distinct(afterGen) },
  afterSusp: { ok: fourRims(afterSusp), distinct: distinct(afterSusp), wheelYstable: Math.abs(afterSusp.corners[0].world[1] - afterGen.corners[0].world[1]) < 1e-6 },
  afterFit: { ok: fourRims(afterFit), distinct: distinct(afterFit) },
  afterCar: { ok: fourRims(afterCar), distinct: distinct(afterCar), wheelSource: afterCar.wheelSource },
  raw: { boot, afterGen, afterSusp, afterFit, afterCar },
};
console.log(JSON.stringify(report, null, 2));
