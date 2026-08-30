// 验证：① 卡片预览为白底（非深色 studio）；② 卡片确实按 plan.carModelUrl 加载车型；
// ③ 车型地址缺失时回退默认、不崩溃。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('/Users/jeremysmac/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:5173/';

const SWAP_URL = '/models/__intercept_car__.glb'; // 用于证明 plan.carModelUrl 被读取

const plans = [
  { id: 'qa-a', title: '白底对照组', carModelUrl: '', updatedAt: Date.now(), desc: '', tags: [], params: null },
  { id: 'qa-b', title: '按车型加载组', carModelUrl: SWAP_URL, updatedAt: Date.now(), desc: '', tags: [], params: null },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const requested = [];
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().includes('__intercept_car__')) {
    requested.push(req.url());
    return req.abort(); // 故意让这个车型地址失败 → 验证回退默认
  }
  req.continue();
});

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console:' + m.text());
});

// 注入方案数据（含一个会触发回退的车型地址），再加载页面
await page.evaluateOnNewDocument((plansJson) => {
  localStorage.setItem('inspire-car-plans', plansJson);
}, JSON.stringify(plans));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000)); // 等卡片预览构建并旋转几帧

const result = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.garage-card')];
  const out = [];
  for (const card of cards) {
    const title = card.querySelector('.garage-card__title')?.textContent || '';
    const canvas = card.querySelector('.garage-card__thumb-canvas');
    if (!canvas) {
      out.push({ title, ok: false, reason: 'no-canvas' });
      continue;
    }
    const ctx = canvas.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0, n = 0, dark = 0;
    for (let i = 0; i < data.length; i += 4 * 37) {
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += lum; n++;
      if (lum < 40) dark++;
    }
    out.push({ title, ok: true, avg: Math.round(sum / n), darkRatio: +(dark / n).toFixed(3), w: width, h: height });
  }
  return out;
});

await browser.close();

console.log('=== 卡片预览采样 ===');
for (const r of result) console.log(JSON.stringify(r));
console.log('=== 是否按 plan.carModelUrl 发起车型请求（回退组应命中） ===');
console.log('intercept requested:', requested.length, requested[0] || '');
console.log('=== 页面/控制台错误 ===');
console.log(pageErrors.length ? pageErrors.join('\n') : '(无)');

// 断言
const whiteCards = result.filter((r) => r.ok && r.avg > 170 && r.darkRatio < 0.5);
const fallbackConsidered = requested.length === 1;
const noFatal = !pageErrors.some((e) => /plan-preview|Cannot|undefined is not/.test(e)) || pageErrors.length === 0;

console.log('\n=== 结论 ===');
console.log('白底卡片:', whiteCards.length, '/', result.length);
console.log('per-plan URL 被读取(回退组命中):', fallbackConsidered);
console.log('无致命错误:', noFatal);

let pass = whiteCards.length === result.length && fallbackConsidered && noFatal;
console.log(pass ? '\n✅ _qa-plan-preview PASS' : '\n❌ _qa-plan-preview FAIL');
process.exit(pass ? 0 : 1);
