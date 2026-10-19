# tools/archive — 归档区

本目录存放**已完成历史使命的一次性工具与产物**。归档而非删除，是为了保留可追溯性：
这些脚本记录了大量真实的踩坑过程与实测数据，将来遇到同类问题仍是有效参考。

**不要在这里开发新功能。** 需要新增脚本请放 `scripts/`（可重复运行的）或
`tools/`（长期使用的辅助工具）。

## qa-scripts/ — 一次性 QA / 调试脚本（21 个）

2026-08 ~ 2026-10 期间，为验证各类 3D 装配、轮毂落位、拍照引导、BANG 拆解等问题
临时编写的调试脚本。它们的特点是：**针对某一次具体样本、跑完即弃**。

已被下列可持续运行的验证脚本取代，日常回归请用 `npm run verify`：

| 归档脚本（示例） | 替代者 |
|---|---|
| `_qa-bang-axle.mjs`、`_qa-bang-classify.mjs`、`_qa-part-classify.mjs` | `scripts/verify-wheel-gate.mjs` |
| `_qa-car-specs-shape.mjs`、`_qa-ratios.mjs` | `scripts/verify-car-specs.mjs`、`scripts/verify-spec-picker.mjs` |
| `_qa-suspension.mjs`、`_qa-fix*.mjs` | `scripts/verify-tire-basis.mjs`、`scripts/verify-et-3d.mjs` |
| `_qa-align.mjs`、`_qa-diff*.py`、`_qa-analyze.py` | 无（拍照引导渲染已由 `scripts/render-guides.mjs` 定型） |

## qa-screenshots/ — QA 过程截图（43 张，约 15MB）

各轮 UI / 3D 效果的验证截图，原散落在仓库根目录，导致公开仓库体积虚胖。
已全部归档到此处。

> ⚠️ 若仓库曾因体积或隐私考虑需要瘦身，可直接删除本子目录——
> 它们不参与任何构建或运行，纯历史记录。
