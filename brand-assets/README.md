# INSPIRE CAR 品牌资产清单 / Brand Asset Manifest

> 来源：用户 2026-10-22 提供的《INSPIRE CAR 品牌识别规范》。本目录所有资产由规范图提取/重制，
> 色彩规范：主色 `#000000`、辅色 `#FFFFFF`、强调色 `#6A6A6A`。

## 目录结构

```
brand-assets/
├── favicon/      # 05 Favicon 网站图标（多尺寸）——深色版 + 浅色背景版各 5 件
├── app-icons/    # 06 App 图标（iOS / Android / Play Store）
├── miniprogram/  # 07 小程序图标（圆形 200 + 胶囊 300，黑底/白底）
├── wordmark/     # 02 横版标志（INSPIRE CAR + MODIFY × EXPLORE × BEYOND）白/黑两版
└── monogram/     # IC 单色图形标志（无容器，透明底）黑/白两版
```

## 各资产用途（按规范图标注）

### favicon/ —— 网站图标（深色版为站点默认，站点为深色主题）
| 文件 | 尺寸 | 规范标注用途 |
|---|---|---|
| `favicon-512.png` | 512×512 | 主图标 |
| `favicon-180.png` | 180×180 | 网页/桌面（apple-touch-icon 同款） |
| `favicon-96.png` | 96×96 | 浏览器标签 |
| `favicon-64.png` | 64×64 | 常规使用 |
| `favicon-32.png` | 32×32 | 小图标 |
| `favicon-light-*.png` | 同上 5 尺寸 | 浅色背景版（白底黑 IC），用于浅色上下文 |

已接入站点：`index.html` 五个 `<link rel="icon">` + `apple-touch-icon`；
PWA `manifest.webmanifest` 的 `icon-192 / icon-512 / maskable-512`（黑底白 IC）。
注意 maskable-512 为**全出血 + IC 收进 80% 安全区**（44% 宽），避免被系统遮罩裁切。

### app-icons/ —— 应用商店提交（全出血方版，系统自行套圆角/加遮罩，**不要自己烤圆边**）
| 文件 | 尺寸 | 用途 |
|---|---|---|
| `ios-app-icon-1024.png` | 1024×1024 | iOS App Store 提交主图（黑底白 IC） |
| `ios-app-icon-dark-1024.png` | 1024×1024 | iOS 深色模式图标 |
| `android-app-icon-1024.png` | 1024×1024 | Android 应用图标（黑底白 IC） |
| `android-app-icon-light-1024.png` | 1024×1024 | Android 浅色模式图标（白底黑 IC） |
| `play-store-icon-512.png` | 512×512 | Google Play 商店图标 |

### miniprogram/ —— 微信小程序
| 文件 | 尺寸 | 用途 |
|---|---|---|
| `miniprogram-icon-200-black.png` | 200×200 | 小程序图标（黑底，白 IC，**圆形**） |
| `miniprogram-icon-200-white.png` | 200×200 | 小程序图标（白底，黑 IC，**圆形**） |
| `miniprogram-capsule-300-black.png` | 300×300 | 小程序胶囊（黑底，白 IC，圆角方） |
| `miniprogram-capsule-300-white.png` | 300×300 | 小程序胶囊（白底，黑 IC，圆角方） |

### wordmark/ —— 横版字标（透明底）
- `wordmark-white.png`（558×93）：白字标，用于深色背景。**已用于站点顶部品牌栏**（`src/assets/logo-wordmark-white.png`）。
- `wordmark-black.png`（558×93）：黑字标，用于浅色背景。

### monogram/ —— IC 单色图形标志（透明底，无容器）
- `ic-monogram-black.png` / `ic-monogram-white.png`（681×291）：用于水印、loading、favicon 源形等需要裸标志的场景。

## 设计规则（规范图 08/09 节）

- IC 单色标志斜切角度 **15°**，I 与 C 为独立两个部件，禁止改角度/比例/部件间距。
- 最小使用尺寸：IC ≥ 16px；INSPIRE CAR 字标 ≥ 80px 宽。
- 容器统一为圆角方形（圆角 ≈ 22.4%）或圆形（仅小程序 200 图标）；App 商店提交用全出血方版。
- 深色版 = `#000000` 底 + 白 IC；浅色版 = `#FFFFFF` 底 + 黑 IC；不用灰底、不加渐变/描边/投影。
