/**
 * wheel-guide-layer.spec.js — 轮毂「单图轮播拍摄弹窗」实测套件（方案 C，2026-10-15 定稿）。
 *
 * 背景：轮毂生成界面不再套用车身拍照引导的全屏蓝图取景框，改为「暗色遮罩 +
 * 居中弹窗（~560px）」，弹窗内容只有轮毂示意图：角度胶囊（正面｜侧面｜斜45°）
 * + 单张大示意图。拍完自动切下一个角度；已拍胶囊打 ✓；点胶囊可回看实拍图。
 *
 * 覆盖：
 *   1) 桌面 1280×800：弹窗水平居中、示意图 1:1 且 ≥280px、当前角度胶囊高亮；
 *      ✕ / Esc / 点遮罩空白 三条关闭路径都可用，关闭后触发卡可再开。
 *   2) 移动 390×844：弹窗不超出视口、页面无水平溢出（scrollWidth ≤ clientWidth）。
 *   3) 拍完自动切角度（1 张→侧面、2 张→斜45°、3 张→全 ✓）；点已拍胶囊回看实拍图
 *      （blob URL 与 thumbs 同源）；3 张跨关闭/重开持久化；打开时 body 滚动锁定。
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
      // 重开弹窗」时上传区状态不被清掉（done 后 main.js 的 u.reset() 是既有的
      // 「拍完下一张」设计，与弹窗本身是否清状态无关，不能混验）。
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

/** 打开轮毂拍摄弹窗并等待示意图可见 */
async function openGuideLayer(page) {
  await page.click('.dropzone:has-text("上传轮毂照片")');
  await page.waitForSelector('.wheel-guide-layer:not(.hidden) .wg-stage', { state: 'visible' });
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

/** 经触发卡内的隐藏 input 选 n 张轮毂图（e2e 契约：.dropzone:has-text(...) input[type=file]） */
async function pickWheelPhotos(page, n) {
  const png = Buffer.from(PNG_1X1, 'base64');
  const files = Array.from({ length: n }, (_, i) => ({ name: `w${i + 1}.png`, mimeType: 'image/png', buffer: png }));
  await page.locator('.dropzone:has-text("上传轮毂照片") input[type=file]').setInputFiles(files);
  await expect.poll(() => page.locator('.wheel-guide-layer .thumbs .thumb').count()).toBe(n);
  // 等缩略图 blob URL 全部填充（makeThumbBlob 异步）
  await expect
    .poll(() =>
      page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('.wheel-guide-layer .thumbs .thumb'));
        return imgs.length > 0 && imgs.every((i) => i.src.startsWith('blob:'));
      })
    )
    .toBe(true);
}

test.describe('轮毂拍摄弹窗（方案 C 单图轮播）', () => {
  test('桌面 1280×800：弹窗居中 + 大示意图 + ✕/Esc/遮罩三条关闭路径', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAsUser(page);
    await mockApi(page);
    await enterStudio(page);
    await openGuideLayer(page);

    // 弹窗水平居中、宽度 ~560
    const modal = await page.locator('.wheel-guide-modal').boundingBox();
    // eslint-disable-next-line no-console
    console.log(`[MEASURE][desktop] modal = ${modal.width.toFixed(1)}x${modal.height.toFixed(1)} @ (${modal.x.toFixed(1)},${modal.y.toFixed(1)})`);
    expect(modal.width).toBeGreaterThanOrEqual(480);
    expect(modal.width).toBeLessThanOrEqual(561);
    expect(Math.abs(modal.x + modal.width / 2 - 640)).toBeLessThanOrEqual(2); // 水平居中

    // 示意图：1:1 且 ≥280px，参考图真实加载完成
    const stage = await page.locator('.wheel-guide-layer .wg-stage').boundingBox();
    // eslint-disable-next-line no-console
    console.log(`[MEASURE][desktop] .wg-stage = ${stage.width.toFixed(1)}x${stage.height.toFixed(1)}`);
    expect(stage.width).toBeGreaterThanOrEqual(280);
    expect(Math.abs(stage.width - stage.height)).toBeLessThanOrEqual(1); // 1:1
    const diagramOk = await page.evaluate(() => {
      const img = document.querySelector('.wheel-guide-layer .wg-diagram');
      return img && img.complete && img.naturalWidth > 0 && img.src.includes('wheel-front');
    });
    expect(diagramOk).toBe(true); // 初始为正面示意图

    // 角度胶囊：3 个，第一个为当前要拍
    await expect(page.locator('.wheel-guide-layer .wg-tab')).toHaveCount(3);
    const cur = page.locator('.wheel-guide-layer .wg-tab.is-current');
    await expect(cur).toHaveCount(1);
    expect(await cur.getAttribute('data-idx')).toBe('0');
    await expect(page.locator('.wheel-guide-layer .wg-count')).toContainText('第 1 / 3 张');

    // ✕ 命中测试：必须命中 ✕ 自身（不得被右下角 fixed 元素遮挡）
    const hit = await hitTest(page, '.wheel-guide-layer:not(.hidden) .wg-close', [
      [0.5, 0.5],
      [0.9, 0.5],
    ]);
    // eslint-disable-next-line no-console
    console.log(`[MEASURE][desktop] wg-close hits = ${JSON.stringify(hit.results)}`);
    expect(hit.ok).toBe(true);

    // 路径 1：✕ 关闭 → body 滚动恢复
    await page.click('.wheel-guide-layer:not(.hidden) .wg-close');
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    // 路径 2：重开 → Esc 关闭
    await openGuideLayer(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    // 路径 3：重开 → 点遮罩空白处（弹窗外）关闭
    await openGuideLayer(page);
    await page.mouse.click(8, 8); // 左上角，弹窗之外 = 遮罩
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    // 关闭后触发卡仍可再开（回归：footer 关闭后触发卡失灵的怀疑）
    await openGuideLayer(page);
    await expect(page.locator('.wheel-guide-layer:not(.hidden) .wg-stage')).toBeVisible();
  });

  test('移动 390×844：弹窗不超出视口、无水平溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsUser(page);
    await mockApi(page);
    await enterStudio(page);
    await openGuideLayer(page);

    const m = await page.evaluate(() => {
      const modal = document.querySelector('.wheel-guide-modal').getBoundingClientRect();
      const stage = document.querySelector('.wheel-guide-layer .wg-stage').getBoundingClientRect();
      return {
        docScrollW: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        modalX: modal.x,
        modalRight: modal.right,
        stageW: stage.width,
        stageH: stage.height,
      };
    });
    // eslint-disable-next-line no-console
    console.log(
      `[MEASURE][mobile] docScrollW=${m.docScrollW} innerWidth=${m.innerWidth}, modal x=${m.modalX.toFixed(1)} right=${m.modalRight.toFixed(1)}, stage=${m.stageW.toFixed(1)}x${m.stageH.toFixed(1)}`
    );
    expect(m.docScrollW).toBeLessThanOrEqual(m.innerWidth); // 页面无水平溢出
    expect(m.modalX).toBeGreaterThanOrEqual(0); // 弹窗不超出左缘
    expect(m.modalRight).toBeLessThanOrEqual(m.innerWidth); // 不超出右缘
    expect(m.stageW).toBeGreaterThanOrEqual(280); // 示意图仍够大
    expect(Math.abs(m.stageW - m.stageH)).toBeLessThanOrEqual(1); // 1:1
  });

  test('拍完自动切角度 + 胶囊回看实拍 + 3 张跨关闭持久化 + body 滚动锁', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAsUser(page);
    await mockApi(page);
    await enterStudio(page);
    await openGuideLayer(page);

    // 打开时锁 body 滚动
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    // 第 1 张：当前角度自动切到「侧面」，正面打 ✓
    await pickWheelPhotos(page, 1);
    expect(await page.locator('.wheel-guide-layer .wg-tab.is-current').getAttribute('data-idx')).toBe('1');
    await expect(page.locator('.wheel-guide-layer .wg-count')).toContainText('第 2 / 3 张');
    await expect(page.locator('.wheel-guide-layer .wg-tab[data-idx="0"]')).toHaveClass(/is-done/);

    // 点「正面」胶囊回看：显示实拍缩略图（blob URL，与 thumbs[0] 同源）
    await page.click('.wheel-guide-layer .wg-tab[data-idx="0"]');
    const shotSrc = await page.locator('.wheel-guide-layer .wg-shot').getAttribute('src');
    const thumb0Src = await page.locator('.wheel-guide-layer .thumbs .thumb').first().getAttribute('src');
    expect(shotSrc).toMatch(/^blob:/);
    expect(shotSrc).toBe(thumb0Src); // 同源，不重复 createObjectURL
    await expect(page.locator('.wheel-guide-layer .wg-meta__label')).toContainText('已拍');

    // 第 2 张（替换语义：选 2 张，高水位推进）：当前角度切到「斜 45°」
    await pickWheelPhotos(page, 2);
    expect(await page.locator('.wheel-guide-layer .wg-tab.is-current').getAttribute('data-idx')).toBe('2');
    await expect(page.locator('.wheel-guide-layer .wg-count')).toContainText('第 3 / 3 张');

    // 第 3 张：三个角度全部 ✓，无当前项，计数显示已拍 3/3
    await pickWheelPhotos(page, 3);
    await expect(page.locator('.wheel-guide-layer .wg-tab.is-done')).toHaveCount(3);
    await expect(page.locator('.wheel-guide-layer .wg-tab.is-current')).toHaveCount(0);
    await expect(page.locator('.wheel-guide-layer .wg-count')).toContainText('已拍 3/3');
    // 大图显示最近一张实拍（与 thumbs 最后一张同源）
    const shotSrc3 = await page.locator('.wheel-guide-layer .wg-shot').getAttribute('src');
    const thumbLast = await page.locator('.wheel-guide-layer .thumbs .thumb').last().getAttribute('src');
    expect(shotSrc3).toBe(thumbLast);

    // ✕ 关闭 → 重开：3 张缩略图、三个 ✓、blob 仍有效（不 dispose、不清空）
    await page.click('.wheel-guide-layer:not(.hidden) .wg-close');
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    await openGuideLayer(page);
    await expect.poll(() => page.locator('.wheel-guide-layer .thumbs .thumb').count()).toBe(3);
    await expect(page.locator('.wheel-guide-layer .wg-tab.is-done')).toHaveCount(3);
    const shotSrc4 = await page.locator('.wheel-guide-layer .wg-shot').getAttribute('src');
    expect(shotSrc4).toMatch(/^blob:/);
    const blobAlive = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        return res.ok && res.headers.get('content-type').startsWith('image/');
      } catch {
        return false;
      }
    }, shotSrc4);
    expect(blobAlive).toBe(true);

    // Esc 关闭 + body 滚动恢复
    await page.keyboard.press('Escape');
    await expect(page.locator('.wheel-guide-layer:not(.hidden)')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  });
});
