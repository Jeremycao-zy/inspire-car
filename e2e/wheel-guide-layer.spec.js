/**
 * wheel-guide-layer.spec.js — 轮毂「全屏拍摄引导层」实测套件。
 *
 * 背景：侧栏仅 348px，两列舞台撑不起大取景框；轮毂上传区改为
 * 「侧栏紧凑触发卡 + 全屏引导层（.wheel-guide-layer）」结构。
 *
 * 覆盖（对应交付自检项）：
 *   1) 桌面 1280×800：全屏层内取景框 .up-viewfinder 宽度 ≥ 700px（实测值打印）。
 *   2) 移动 390×844：取景框吃满可用列宽、无水平溢出（scrollWidth ≤ clientWidth）、
 *      右下角括号不被裁（旧 min-height:320 + 4:3 会把宽回灌成 426px 溢出，已改 1:1）。
 *   3) footer 关闭键可命中：elementFromPoint 点中心 + 右缘必须命中关闭键本身
 *     （#sfx-mute-btn fixed z-index 9999 曾遮挡，层 z-index 已提至 10050）。
 *   4) 选 3 张照片 → 关闭 → 重开：3 张缩略图、ghost 高水位停在第 3 项、
 *      取景框照片 blob URL 仍然有效（跨开关层不丢失、不 dispose）。
 *   5) Esc 关闭；打开时 body 滚动锁定（overflow:hidden），关闭后恢复。
 *
 * 所有 /api/ 请求按 pathname 精确拦截（勿用通配匹配，会误伤 /src/api 模块请求）。
 */

import { test, expect } from '@playwright/test';

const MOCK_USER = { id: 'u_test', username: 'tester' };
// 1×1 透明 PNG：足以走完 makeThumbBlob 压缩与 <img> 解码
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function mockApi(page) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();

    if (url.pathname === '/api/auth/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER }) });
    }
    if (url.pathname === '/api/plans') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plans: [] }) });
    }
    if (url.pathname === '/api/generate' && req.method() === 'POST') {
      // 按 kind 分流：car（拍照引导建整车）必须回 done，否则工作室挂不上；
      // wheel 只回 accepted/polling 不发 done，让生成保持在途——模拟「生成中关闭/
      // 重开引导层」时上传区状态不被 layer 清掉（done 后 main.js 的 u.reset() 是
      // 既有的「拍完下一张」设计，与 layer 本身是否清状态无关，不能混验）。
      let kind = '';
      try {
        kind = JSON.parse(req.postData() || '{}').kind || '';
      } catch {}
      const sse = [
        'data: ' + JSON.stringify({ stage: 'accepted', jobId: 'job_mock', progress: 0.1, message: '受理' }) + '\n\n',
        'data: ' + JSON.stringify({ stage: 'polling', progress: 0.5, message: '生成中' }) + '\n\n',
      ];
      if (kind !== 'wheel') {
        sse.push(
          'data: ' +
            JSON.stringify({
              stage: 'done',
              progress: 1,
              message: '完成',
              result: { url: '/models/rim-default.glb', kind: 'car', mode: 'live', parts: null },
            }) +
            '\n\n'
        );
      }
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse.join('') });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function loginAsUser(page) {
  await page.addInitScript((user) => {
    try {
      localStorage.setItem('inspire-auth-token', 'mock-token');
      localStorage.setItem('inspire-auth-user', JSON.stringify(user));
    } catch {}
  }, MOCK_USER);
}

/** 新建方案 → 拍照引导传 5 张整车图 → 开始生成 → 等工作室侧栏的轮毂触发卡出现 */
async function enterStudio(page) {
  await page.goto('/');
  await page.click('button:has-text("新建改装方案")');
  await page.waitForSelector('.photo-guide__card input[type=file]', { state: 'visible' });

  const angleInputs = page.locator('.photo-guide__card input[type=file]');
  const angleN = await angleInputs.count();
  const png = Buffer.from(PNG_1X1, 'base64');
  for (let i = 0; i < angleN; i++) {
    await angleInputs.nth(i).setInputFiles({ name: `car${i}.png`, mimeType: 'image/png', buffer: png });
  }
  // 开始建模（f4a23d3 重构后主按钮为 .photo-guide__start，5/5 张后自动启用）
  await page.click('.photo-guide__start');

  // 工作室挂载后：切到「轮毂」分页，侧栏轮毂上传区是紧凑触发卡
  // （.dropzone + 「上传轮毂照片」e2e 契约）
  await page.click('.tab[data-tab="wheels"]');
  await page.waitForSelector('.dropzone:has-text("上传轮毂照片")', { timeout: 30_000 });
}

/** 打开全屏引导层并等待取景框可见 */
async function openGuideLayer(page) {
  await page.click('.dropzone:has-text("上传轮毂照片")');
  await page.waitForSelector('.wheel-guide-layer:not(.hidden) .up-viewfinder', { state: 'visible' });
}

/** elementFromPoint 命中测试：点元素上若干相对坐标点，必须命中元素本身（或其子元素） */
async function hitTest(page, selector, points) {
  return page.evaluate(
    ({ selector, points }) => {
      const el = document.querySelector(selector);
      if (!el) return { ok: false, reason: 'not found', results: [] };
      const r = el.getBoundingClientRect();
      const results = points.map(([fx, fy]) => {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        return {
          fx,
          fy,
          hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : 'null',
          ok: !!hit && (hit === el || el.contains(hit)),
        };
      });
      return { ok: results.every((x) => x.ok), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, results };
    },
    { selector, points }
  );
}

test.describe('轮毂全屏拍摄引导层', () => {
  test('桌面 1280×800：取景框宽度 ≥ 700px + footer 关闭键可命中（不被 #sfx-mute-btn 遮挡）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAsUser(page);
    await mockApi(page);
    await enterStudio(page);
    await openGuideLayer(page);

    const rect = await page.locator('.wheel-guide-layer .up-viewfinder').boundingBox();
    // eslint-disable-next-line no-console
    console.log(`[MEASURE][desktop 1280x800] .up-viewfinder width = ${rect.width.toFixed(1)}px, height = ${rect.height.toFixed(1)}px`);
    expect(rect.width).toBeGreaterThanOrEqual(700);

    // 缺陷 1 回归：footer 关闭键中心 + 右缘必须命中关闭键本身
    // （#sfx-mute-btn 是 fixed bottom-right z-index 9999，层 z-index 提到 10050 盖住它）
    const closeSel = '.wheel-guide-layer:not(.hidden) .wheel-guide__footer-close';
    const hit = await hitTest(page, closeSel, [
      [0.5, 0.5],
      [0.95, 0.5],
    ]);
    // eslint-disable-next-line no-console
    console.log(`[MEASURE][desktop] footer-close rect = ${hit.rect.w.toFixed(1)}x${hit.rect.h.toFixed(1)} @ (${hit.rect.x.toFixed(1)},${hit.rect.y.toFixed(1)}), hits = ${JSON.stringify(hit.results)}`);
    expect(hit.ok).toBe(true);

    // 经 footer 关闭键关闭（Playwright click 自带命中检测，被遮挡会超时失败）
    await page.click(closeSel);
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    // 重开后 ✕ 路径依旧可用（双关闭路径都通）
    await openGuideLayer(page);
    await page.click('.wheel-guide-layer:not(.hidden) .wheel-guide__close');
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
  });

  test('移动 390×844：取景框吃满可用宽度且不水平溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsUser(page);
    await mockApi(page);
    await enterStudio(page);
    await openGuideLayer(page);

    const rect = await page.locator('.wheel-guide-layer .up-viewfinder').boundingBox();
    // eslint-disable-next-line no-console
    console.log(`[MEASURE][mobile 390x844] .up-viewfinder width = ${rect.width.toFixed(1)}px, height = ${rect.height.toFixed(1)}px`);

    // 缺陷 2 回归：无横滚、右下角括号不被裁、取景框吃满可用列宽
    const m = await page.evaluate(() => {
      const sc = document.querySelector('.wheel-guide-layer:not(.hidden) .wheel-guide__scroll');
      const vf = document.querySelector('.wheel-guide-layer .up-viewfinder');
      const br = document.querySelector('.wheel-guide-layer .up-viewfinder__corner--br');
      const cs = getComputedStyle(sc);
      const avail = sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const vr = vf.getBoundingClientRect();
      const brr = br.getBoundingClientRect();
      return {
        scrollWidth: sc.scrollWidth,
        clientWidth: sc.clientWidth,
        avail,
        vfWidth: vr.width,
        vfHeight: vr.height,
        vfRight: vr.right,
        brRight: brr.right,
        innerWidth: window.innerWidth,
      };
    });
    // eslint-disable-next-line no-console
    console.log(
      `[MEASURE][mobile] scroll scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}, avail=${m.avail.toFixed(1)}, ` +
        `vf=${m.vfWidth.toFixed(1)}x${m.vfHeight.toFixed(1)} right=${m.vfRight.toFixed(1)}, brRight=${m.brRight.toFixed(1)}, innerWidth=${m.innerWidth}`
    );
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth); // 无横滚
    expect(m.brRight).toBeLessThanOrEqual(m.innerWidth); // 右缘括号不被裁
    expect(m.vfWidth).toBeGreaterThanOrEqual(m.avail - 1); // 吃满可用列宽
    expect(m.vfWidth).toBeLessThanOrEqual(m.avail + 1);
    expect(m.vfHeight).toBeGreaterThanOrEqual(300); // 1:1 派生高度仍 ≥ 原 300 阈值
  });

  test('3 张照片跨开关层持久化 + Esc 关闭 + body 滚动锁', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAsUser(page);
    await mockApi(page);
    await enterStudio(page);
    await openGuideLayer(page);

    // 打开时锁 body 滚动
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe('hidden');

    // 经触发卡内的隐藏 input 选 3 张（e2e 契约：.dropzone:has-text(...) input[type=file]）
    const png = Buffer.from(PNG_1X1, 'base64');
    const wheelInput = page.locator('.dropzone:has-text("上传轮毂照片") input[type=file]');
    await wheelInput.setInputFiles([
      { name: 'w1.png', mimeType: 'image/png', buffer: png },
      { name: 'w2.png', mimeType: 'image/png', buffer: png },
      { name: 'w3.png', mimeType: 'image/png', buffer: png },
    ]);

    // 3 张缩略图就绪（blob URL 已填充）
    await expect.poll(() => page.locator('.wheel-guide-layer .thumbs .thumb').count()).toBe(3);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('.wheel-guide-layer .thumbs .thumb'));
          return imgs.every((i) => i.src.startsWith('blob:'));
        })
      )
      .toBe(true);

    // ghost 高水位推进到第 3 项：3/3 全部 done，ghost 停在第 3 项（is-active）
    await expect.poll(() => page.locator('.wheel-guide-layer .up-guide-item.is-done').count()).toBe(3);
    await expect(page.locator('.wheel-guide-layer .up-guide-item.is-active')).toHaveCount(1);
    const activeIdx = await page.locator('.wheel-guide-layer .up-guide-item.is-active').getAttribute('data-idx');
    expect(activeIdx).toBe('2'); // 第 3 张拍完，ghost 停在第 3 项
    // 取景框显示已选照片（与 thumbs 最后一张共享 blob URL）
    const shotSrc = await page.locator('.wheel-guide-layer .up-viewfinder__shot').getAttribute('src');
    expect(shotSrc).toMatch(/^blob:/);
    await expect(page.locator('.wheel-guide-layer .up-viewfinder__shot')).toBeVisible();

    // ✕ 关闭：层隐藏 + body 滚动恢复
    await page.click('.wheel-guide-layer:not(.hidden) .wheel-guide__close');
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .not.toBe('hidden');

    // 重开：3 张照片 + ghost 停在第 3 项 + blob 仍有效（不 dispose、不清空）
    await openGuideLayer(page);
    await expect.poll(() => page.locator('.wheel-guide-layer .thumbs .thumb').count()).toBe(3);
    await expect.poll(() => page.locator('.wheel-guide-layer .up-guide-item.is-done').count()).toBe(3);
    const shotSrc2 = await page.locator('.wheel-guide-layer .up-viewfinder__shot').getAttribute('src');
    expect(shotSrc2).toMatch(/^blob:/);
    const activeIdx2 = await page.locator('.wheel-guide-layer .up-guide-item.is-active').getAttribute('data-idx');
    expect(activeIdx2).toBe('2'); // ghost 仍停在第 3 项
    const blobAlive = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        return res.ok && res.headers.get('content-type').startsWith('image/');
      } catch {
        return false;
      }
    }, shotSrc2);
    expect(blobAlive).toBe(true);

    // Esc 关闭 + body 滚动恢复
    await page.keyboard.press('Escape');
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .not.toBe('hidden');
  });
});
