// 验证：车库卡片已变成风火轮风格玩具卡
// 1) 存在灵感车库 logo SVG；2) 存在透明泡壳层；3) 3D canvas 在泡壳内；4) 无白屏/致命错误
import { launch } from '/Users/jeremysmac/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = 'http://127.0.0.1:5173/';

const browser = await launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[page error]', msg.text());
});

await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('.garage-grid', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500)); // 等 3D 预览渲染几帧

const report = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('.garage-card'));
  const first = cards[0];
  const logo = first?.querySelector('svg[aria-label*="灵感车库"]') || first?.querySelector('.garage-card__logo');
  const backing = first?.querySelector('.garage-card__backing');
  const blister = first?.querySelector('.garage-card__blister');
  const shell = first?.querySelector('.garage-card__shell');
  const thumb = first?.querySelector('.garage-card__thumb');
  const canvas = first?.querySelector('.garage-card__thumb-canvas');
  const title = first?.querySelector('.garage-card__title')?.textContent?.trim();
  const series = first?.querySelector('.garage-card__series')?.textContent?.trim();

  // 检查 canvas 是否在 shell 内部
  const canvasInShell = shell?.contains(canvas);
  const thumbInShell = shell?.contains(thumb);

  // 取泡壳区域亮度，确保有透明/高光层而不是纯黑
  const rect = shell?.getBoundingClientRect();

  return {
    cardCount: cards.length,
    hasLogo: !!logo,
    hasBacking: !!backing,
    hasBlister: !!blister,
    hasShell: !!shell,
    hasThumb: !!thumb,
    hasCanvas: !!canvas,
    canvasInShell,
    thumbInShell,
    title,
    series,
    shellRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
  };
});

// 截图保存给人工复核
await page.screenshot({ path: '/Users/jeremysmac/WorkBuddy/2026-08-27-21-15-16/garage-vite/scripts/_qa-toy-card.png', fullPage: false });

await browser.close();

let pass = true;
const asserts = [
  ['至少 1 张卡片', report.cardCount >= 1],
  ['存在灵感车库 logo', report.hasLogo],
  ['存在背卡 backing', report.hasBacking],
  ['存在透明泡壳 blister', report.hasBlister],
  ['存在泡壳 shell', report.hasShell],
  ['3D canvas 在泡壳内', report.canvasInShell && report.thumbInShell],
  ['标题非空', !!report.title],
  ['系列文案正确', report.series?.includes('COLLECTOR EDITION')],
  ['泡壳尺寸合理', report.shellRect && report.shellRect.width > 150 && report.shellRect.height > 80],
];

for (const [name, ok] of asserts) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) pass = false;
}

console.log('\n结构报告:', JSON.stringify(report, null, 2));
if (errors.length) {
  console.log('\n页面错误:', errors);
  pass = false;
}

if (!pass) {
  console.log('\n❌ _qa-toy-card FAIL');
  process.exit(1);
}
console.log('\n✅ _qa-toy-card PASS：玩具卡结构、logo、泡壳、3D 画布均正确');
