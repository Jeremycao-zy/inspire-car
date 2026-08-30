# 图生 3D LIVE 模式 MVP —— 实现总结

## 本次做了什么

把「灵感改装」项目从 **DEMO 演示模式** 切到 **真实调用腾讯混元 3D** 的 LIVE 模式，并完成用户可见的凭证失效、超时续等、失败分级等核心体验。

## 关键结论

- **不需要你注册任何账号**。凭证由 WorkBuddy 内置云端代理从当前 IDE 会话自动获取，写入 `~/.workbuddy/tokens/hunyuan3d` 即可。
- 当前凭证 `tk_ScFRKumsER0plIygsSMrGkVa6tDj17mQ`，有效期至 **2026-08-30 12:47:03Z**，约 23 小时。
- **后端每次请求都会重新读取凭证文件**，所以换票后点面板里的「我已更新」就能恢复，不用重启服务。

## 改动文件

| 文件 | 改动 |
|------|------|
| `server/index.mjs` | LIVE 块重写：`auth_error`/`timeout`/`retry` 新 SSE 阶段、`resumeJobId` 续等、下载 3 次重试、成功计数 `usage.json`、历史索引 `index.json`、可读命名、带 `tokenId` 的 `/api/health` |
| `server/hunyuan3d.mjs` | 新增 `AUTH_CODES` + `classifyError()`，把 401/403/签名错误统一归类为 `auth` |
| `src/api/generate.js` | 新增 `GenerateError` 结构化错误，支持 `resumeJobId`、压缩图复用、透传 `tokenId` |
| `src/ui/panel.js` | 状态卡四态（live/expiring/expired/demo）、上传区恢复动作按钮与错误细节、拒绝型失效与过期型失效区分 |
| `src/main.js` | 统一 `runGenerate()`、失败分级 UI、绝不自动降级演示模型、`refreshHealth()` 5 分钟复查 |
| `src/ui/styles.css` | 四态状态卡、恢复按钮、失效/警告状态色 |

## 验证结果

| 验证项 | 结果 |
|--------|------|
| 后端真实生成一次 | ✅ 38MB glTF 2.0，SSE 完整 `submit → polling → downloading → done` |
| 红线：凭证失效不降级演示模型 | ✅ 终止态为 `auth_error`，未返回 `my-car.glb`/`wheel.glb` |
| 前端 auth 错误 UI（12 项断言） | ✅ 全部通过 |
| 换票恢复闭环（7 项断言） | ✅ 写新票 → 点「我已更新」→ 自动回到 LIVE，无需重启 |
| 真实模型进装配流水线（9 项断言） | ✅ 网格/面数/PBR/四轮定位/车壳切割均接管 |

## 已发现/已说明的限制

1. **当前 38MB 真实产物是用项目 logo 测试生成的抽象物体**，不是汽车，所以包围盒比例荒诞。真实汽车照片会生成正常车身。
2. **混元 3D 一次真实生成会消耗 1 次额度**，失败不计数。
3. 多视角图当前只传第一张，其余丢弃（P2，未在本次实现）。

## 下一步建议

- 用真实汽车照片跑一遍完整流程，确认车身比例正常。
- 继续第二批任务：`npm run token` 换票脚本、本地模型库页面、失败分类日志落盘、用户拍摄引导。
