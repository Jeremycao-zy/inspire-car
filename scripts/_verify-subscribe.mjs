/**
 * 验证订阅方案入口截图脚本
 * 1. 线上注册/登录
 * 2. 注入 token 到 localStorage
 * 3. 打开首页并截图
 */

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://inspire-car-production.up.railway.app';
const USER = 'wbtemp';
const PASS = 'wbtemp123';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '../outputs/qa-subscribe-verified.png');

async function main() {
  // 登录拿 token
  const loginRes = await fetch(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: USER, password: PASS }),
  });
  const loginData = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginData.token) {
    console.error('登录失败', loginData);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // 先访问同域页面并写入 token
  await page.goto(ORIGIN);
  await page.evaluate(
    ({ token, user }) => {
      localStorage.setItem('inspire-car-token', token);
      localStorage.setItem('inspire-car-user', JSON.stringify(user));
    },
    { token: loginData.token, user: loginData.user }
  );

  // 刷新后应进入车库
  await page.goto(ORIGIN);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  // 截图车库入口（带订阅按钮）
  await page.screenshot({ path: out, fullPage: false });

  // 点击订阅按钮并截图弹窗
  await page.click('.garage-subscribe-btn');
  await page.waitForTimeout(600);
  const modalOut = path.resolve(__dirname, '../outputs/qa-subscribe-modal.png');
  await page.screenshot({ path: modalOut, fullPage: false });

  await browser.close();
  console.log('截图已保存:', out, modalOut);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
