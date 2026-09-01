# 灵感改装 garage-vite —— 最新修复总结

## 本次做了什么

处理用户反馈「车底盘下一直有一个大轮毂」的问题，通过加强场景清理、杜绝轮毂/BANG 产物跨车/跨方案残留来删除异常轮毂。

## 关键改动

| 文件 | 改动 |
|------|------|
| `src/main.js` | 新增 `resetWheelToProcedural()`；在 `loadCarFromUrl`、`clearBangParts`、`applyPlanToApp`、`loadWheelFromUrl` 拒绝路径中统一调用，确保旧轮毂模板和 BANG 产物不会残留到下一台车/下一个方案。 |

## 修复逻辑

- **加载新车前**：`loadCarFromUrl()` 已调用 `clearBangParts()`，现在额外调用 `resetWheelToProcedural()`，旧车的异常轮毂不会带到新车。
- **清除拆解产物时**：`clearBangParts()` 末尾调用 `resetWheelToProcedural()`，拆解车身移除的同时把轮毂也恢复成程序化款。
- **进入方案时**：`applyPlanToApp()` 先执行 `clearBangParts()` + `resetWheelToProcedural()`，避免上一方案的残留状态污染当前方案。
- **生成轮毂被拒绝时**：`loadWheelFromUrl()` 在形状校验失败后，释放本次 group 的同时也释放旧 `wheelGroup`，防止异常模型继续占用 rig。

## 测试入口

- 本地 dev 服务：http://127.0.0.1:5173/
- 后台服务：http://127.0.0.1:8787/api/health（200）
- 刷新浏览器即可生效；如仍看到旧轮毂，可在「整车」面板点「清除拆解产物」强制清理。

## 验证结果

- 默认 SL 350 与生成赛车 + BANG 拆解场景均显示 4 只正常轮毂，车底无异常大轮毂。
- 服务 5173/8787 在线，无 JS 报错。
