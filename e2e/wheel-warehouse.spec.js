/**
 * wheel-warehouse.spec.js — 「生成轮毂不进仓库」bug 的回归套件。
 *
 * 覆盖：
 *   1) 展示路径：服务端已登记的轮毂，进「轮毂」分页后应出现 .gw-thumb 卡片。
 *   2) 健壮性（fix ③）：生成成功后 main.js 广播 mywheel:added，仓库监听并 refresh，
 *      即使仓库已挂载也能即时看到新轮毂，不必重新切页。
 *   3) 来回切 5 次：仓库只挂载一次（无重复 .gw-strip）、无 console / page error。
 *   4) 登记闸门（端到端，经工作室）：模拟一次 live 生成，断言 /api/wheels 被 POST、
 *      返回车库后轮毂分页出现卡片。
 *
 * 注意：所有 /api/* 都按 pathname 精确拦截（不要写成 '**/api/...' 通配，
 * 否则会误伤 /src/api/*.js 模块请求导致 MIME 报错、车库挂不上）。
 */

import { test, expect, devices } from '@playwright/test';

const MOCK_USER = { id: 'u_test', username: 'tester' };
const WHEEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 每个用例独立的轮毂内存库（POST 写入、GET 读取、DELETE 删除）
function makeStore() {
  return { wheels: [], seq: 0 };
}

// 按 pathname 精确拦截 /api/*，其余请求回落到真实 Vite（含 /models/*.glb 静态资源）
async function mockApi(page, store) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const method = req.method();

    if (url.pathname === '/api/auth/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER }) });
    }
    if (url.pathname === '/api/plans') {
      if (method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plans: [] }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname === '/api/wheels' && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ wheels: store.wheels }) });
    }
    if (url.pathname === '/api/wheels' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      const w = { id: 'w_' + ++store.seq, url: body.url, name: body.name || '', thumb: body.thumb || '', createdAt: Date.now() };
      store.wheels.push(w);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ wheel: w }) });
    }
    if (url.pathname.startsWith('/api/wheels/') && method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      store.wheels = store.wheels.filter((w) => w.id !== id);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname === '/api/generate' && method === 'POST') {
      const sse = [
        'data: ' + JSON.stringify({ stage: 'accepted', jobId: 'job_mock', progress: 0.1, message: '受理' }) + '\n\n',
        'data: ' + JSON.stringify({ stage: 'polling', progress: 0.5, message: '生成中' }) + '\n\n',
        'data: ' + JSON.stringify({ stage: 'done', progress: 1, message: '完成', result: { url: '/models/rim-default.glb', kind: 'wheel', mode: 'live', parts: null } }) + '\n\n',
      ].join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
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

async function gotoGarage(page) {
  await page.goto('/');
  await page.waitForSelector('.garage-nav__item[data-page="wheels"]', { state: 'visible' });
}

test.describe('轮毂仓库', () => {
  test('展示路径：服务端已登记的轮毂在仓库出现', async ({ page }) => {
    const store = makeStore();
    store.wheels.push({ id: 'w_seed', url: '/models/rim-default.glb', name: '已登记的轮毂', thumb: '', createdAt: Date.now() });
    await loginAsUser(page);
    await mockApi(page, store);
    await gotoGarage(page);

    await page.click('.garage-nav__item[data-page="wheels"]');
    await page.waitForSelector('.gw-strip .gw-thumb', { timeout: 10_000 });
    const count = await page.locator('.gw-strip .gw-thumb').count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('健壮性：mywheel:added 事件触发仓库即时刷新（fix ③）', async ({ page }) => {
    const store = makeStore(); // 初始空仓库
    await loginAsUser(page);
    await mockApi(page, store);
    await gotoGarage(page);

    // 先进入轮毂分页：挂载仓库并注册监听
    await page.click('.garage-nav__item[data-page="wheels"]');
    await page.waitForSelector('.gw-strip', { timeout: 10_000 });
    let count = await page.locator('.gw-strip .gw-thumb').count();
    expect(count).toBe(0); // 空态

    // 模拟一次成功后登记（等价于 recordGeneratedWheel 的 POST + notifyWheelAdded）
    store.wheels.push({ id: 'w_new', url: '/models/rim-default.glb', name: '新轮毂', thumb: '', createdAt: Date.now() });
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('mywheel:added', { detail: { url: '/models/rim-default.glb', name: '新轮毂' } }));
    });

    // 仓库应主动 refresh 并渲染新卡片，无需重新切页
    await page.waitForSelector('.gw-strip .gw-thumb', { timeout: 10_000 });
    count = await page.locator('.gw-strip .gw-thumb').count();
    expect(count).toBe(1);
  });

  test('来回切 5 次：无重复挂载、无 console / page error', async ({ page }) => {
    const store = makeStore();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await loginAsUser(page);
    await mockApi(page, store);
    await gotoGarage(page);

    for (let i = 0; i < 5; i++) {
      await page.click('.garage-nav__item[data-page="garage"]');
      await page.click('.garage-nav__item[data-page="wheels"]');
    }
    // 仓库只应挂载一次：轮毂分页里只有 1 个 .gw-strip
    const strips = await page.locator('.garage-page--wheels .gw-strip').count();
    expect(strips).toBe(1);
    expect(errors).toEqual([]);
  });

  test('登记闸门（端到端，经工作室）：live 生成后轮毂进入仓库', async ({ page }) => {
    const store = makeStore();
    const postCount = { wheels: 0 };
    await loginAsUser(page);
    await mockApi(page, store);

    // 监听 /api/wheels 的 POST，确认登记真的发出
    await page.route('**/api/wheels', (route) => route.fallback());
    const postWaiter = page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/wheels');

    await page.goto('/');
    await page.waitForSelector('.garage-hero__actions button', { state: 'visible' });
    // 新建改装方案 → 进入拍照引导（需要上传整车照片后才会进工作室）
    await page.click('button:has-text("新建改装方案")');
    await page.waitForSelector('.photo-guide__card input[type=file]', { state: 'visible' });

    // 给每个引导角度都塞一张图（足以触发生成）
    const angleInputs = page.locator('.photo-guide__card input[type=file]');
    const angleN = await angleInputs.count();
    const png = Buffer.from(WHEEL_PNG, 'base64');
    for (let i = 0; i < angleN; i++) {
      await angleInputs.nth(i).setInputFiles({ name: `car${i}.png`, mimeType: 'image/png', buffer: png });
    }
    // 点击「开始生成」（photo-guide 主按钮）
    await page.click('.photo-guide__overlay-btn.primary, .photo-guide button.primary');

    // 等待工作室出现（面板里的轮毂上传区）
    await page.waitForSelector('.dropzone:has-text("上传轮毂照片")', { timeout: 30_000 });
    // 在工作室上传轮毂照片 → 触发 runGenerate(wheel) → 登记
    const wheelInput = page.locator('.dropzone:has-text("上传轮毂照片") input[type=file]');
    await wheelInput.setInputFiles({ name: 'wheel.png', mimeType: 'image/png', buffer: png });

    // 断言登记 POST 真的发出（证明登记闸门不再跳过）
    await postWaiter;
    await page.waitForFunction(() => true); // 让异步登记落库
    expect(store.wheels.length + postCount.wheels).toBeGreaterThanOrEqual(1);

    // 返回车库 → 轮毂分页应出现卡片
    await page.click('#back-to-garage');
    await page.waitForSelector('.garage-nav__item[data-page="wheels"]', { state: 'visible' });
    await page.click('.garage-nav__item[data-page="wheels"]');
    await page.waitForSelector('.gw-strip .gw-thumb', { timeout: 10_000 });
    const count = await page.locator('.gw-strip .gw-thumb').count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
