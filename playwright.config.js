/**
 * playwright.config.js — 轮毂仓库 bug 回归配置。
 *
 * 关键：所有 /api/* 都在用例里用 page.route 按 pathname 精确拦截（mock 登录态 +
 * 轮毂仓库读写 + generate SSE），不依赖真实后端，也不需要 3D 凭证。
 * 仅用 Vite 起 SPA 与 public/models 静态资源（轮毂 GLB）。
 */
import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 5180;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${WEB_PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
