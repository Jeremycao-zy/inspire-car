# HANDOFF — 交给 AI IDE（Trae）接手前的工程说明

> 这份文档写给接手开发的 AI 助手和开发者。读它就够开始干活，不必先读完全部代码。

---

## 一、项目是什么

**灵感改装 / INSPIRE CAR** — 上传车辆照片 → AI 识别车型 → 生成 3D 改装模型 → 实时调参（轮毂 / ET / 倾角 / 悬挂高度）。

线上地址：`https://www.inspire-car.com`

---

## 二、架构铁律（改动前必读，违反会破坏现有设计）

这几条是这个项目的**硬约束**，不是风格偏好：

### 1. 后端零三方依赖

`server/` 下**不使用 Express / Koa / Fastify 等任何框架**，只用 Node 内置模块（`node:http`、`node:crypto`、`node:fs`）。

- ❌ 不要 `npm install express`
- ❌ 不要引入 `wechatpay-node-v3`、`alipay-sdk` 之类的 SDK
- ✅ 需要签名就用 `node:crypto` 自己签（`server/pay.mjs` 就是范例）

原因：镜像小、冷启动快、无供应链风险。这是刻意的选择。

### 2. 路由是手写的，不是框架

`server/index.mjs` 用 `if (pathname === '/api/xxx')` 手动分发，约 2500 行。

- 新增接口：在 `index.mjs` 里找到路由分发区，按现有风格追加 `if` 分支
- 不要为了"整齐"重构路由层

### 3. 数据层双模式

`server/db.mjs` 同时支持两种存储，**靠 `DATABASE_URL` 是否设置自动切换**：

- 有 `DATABASE_URL` → PostgreSQL（生产）
- 没有 → JSON 文件落在 `.cache/`（本地开发、单机）

**任何新增的数据操作都必须为两种模式各写一遍。** 只写 PG 版会导致本地开发直接崩。

### 4. 前端是原生 JS ESM，不是框架

`src/` 用原生 ES Module + Three.js，由 Vite 打包。没有 React / Vue。

- 新 UI 组件：按 `src/ui/*.js` 现有风格写（`el()` 辅助函数创建 DOM）
- 不要因为"更方便"而引入 React

### 5. 生产是单端口全栈

`server/index.mjs` 同时服务 `dist/` 静态产物和 `/api/*`。靠 `SERVE_STATIC=1` 开启。

不要拆成前后端两个服务。

---

## 三、目录地图

```
server/                  后端（零依赖）
  index.mjs              主入口，手动路由 + 生成 pipeline
  db.mjs                 双模式数据层（PG / JSON）
  auth.mjs               JWT 鉴权、账号注册登录
  pay.mjs                支付：微信 V3 + 支付宝（node:crypto 自签）
  cost.mjs               credit 成本账本（内部用，对用户不可见）
  hyper3d.mjs            Hyper3D Rodin 生成 + BANG 部件拆解
  vision.mjs             车型识别（Qwen3-VL / 混元 / OpenAI 三级探测）
  static.mjs             静态资源服务
  sms.mjs / oauth.mjs    短信、第三方登录
  wheels.mjs / specs.js  轮毂库、车辆参数库

src/                     前端（原生 ESM + Three.js）
  main.js                入口，import 样式与各面板
  ui/                    各功能面板（garage / subscribe / auth / ...）
  tuning/                调参逻辑
  core/                  3D 场景核心
  api/                   后端接口封装

public/                  静态资源（models/ 下是 GLB 模型，约 41MB）
scripts/                 构建与验证脚本（verify-*.mjs 是参数校验）
dist/                    构建产物（git 忽略）
.cache/                  运行时数据：用户、订单、额度、GLB 缓存（git 忽略）
```

---

## 四、启动与构建

```bash
npm install                 # 安装依赖
npm run dev                 # 开发：前端 5173 + 后端 8787（热更新）
npm run build               # 构建 dist/
npm start                   # 生产模式单端口（8080）
```

验证脚本（改车辆参数逻辑后必跑）：

```bash
npm run verify              # 跑全部 7 个参数校验脚本
```

---

## 五、环境变量

完整清单见 `.env.example`。**当前仓库没有 `.env`，需要自己建。**

不配也能跑：所有第三方能力都会自动降级到 DEMO 模式（返回预置模型），界面照常可用。

关键变量分三组：

| 组 | 变量 | 用途 |
|---|---|---|
| 3D 生成 | `HYPER3D_API_KEY` | Rodin 生成 + BANG 拆解 |
| 车型识别 | `QWEN_API_KEY`（推荐） | Qwen3-VL 识别车型年款 |
| 支付 | `WXPAY_*` / `ALIPAY_*` | 微信 / 支付宝（见第七节） |
| 站点 | `APP_BASE_URL` | 拼支付回调地址 |

---

## 六、成本结构（改定价或改生成流程前必读）

**一次整车生成 = 1.0 credit = Rodin 0.5 + BANG 0.5**

- `server/cost.mjs` 会把每次提交的真实 `consumed` 记到 `.cache/cost-ledger.jsonl`
- 看报表：`node scripts/cost-report.mjs 7`
- credit 单价约 ¥4.15（Business 订阅）～ ¥10.8（直充）

**对用户永远只卖"次"，不卖 credit、不卖充值余额。** 暴露 credit 等于公开成本表，且预付余额有监管与退款风险。

---

## 七、支付模块现状（最近一次开发）

已实现，**但通道密钥未配置，线上还收不了钱**。

### 已落地的文件

| 文件 | 作用 |
|---|---|
| `server/pay.mjs` | 微信 V3 下单/回调验签/AES-GCM 解密 + 支付宝 RSA2 签名/验签 |
| `public/pay.html` | 收银页，微信内走 JSAPI、浏览器走支付宝 |
| `PAYMENT_SETUP.md` | 开通流程与配置说明 |
| `server/db.mjs` | 新增 `orders` / `entitlements` / `payment_logs` 三表 |

### 接口

```
GET  /api/pay/plans          套餐列表（含 channels 可用状态）
POST /api/pay/create         创建订单，需登录
POST /api/pay/wx/notify      微信回调（验签 + 幂等发货）
POST /api/pay/ali/notify     支付宝回调
GET  /api/pay/order/:no      订单查询
GET  /api/pay/entitlements   我的权益
```

### 定价（`server/pay.mjs` 的 `PLANS`，与 `src/ui/subscribe.js` 同步）

| id | 价格 | 内容 |
|---|---|---|
| `single` | ¥29 | 1 次 |
| `pack5` | ¥99 | 5 次 |
| `pack12` | ¥199 | 12 次 |
| `studio` | ¥399 / 30 天 | 20 次（B 端） |
| `pro` | ¥999 / 30 天 | 60 次（B 端） |

**定价下限：单次售价 ≥ 3 × 单次成本。** 低于这个数就是卖得越多亏得越多。

### 权益扣减顺序（已修过一个严重 bug）

先扣订阅剩余次数 → 用完溢出到次数包 → 都没有才拒绝。

历史 bug：订阅曾硬编码 `quota=0` 且扣减时直接放行，导致月卡可以无限用。**不要退回那个逻辑。**

### 本地验证

```bash
PORT=8899 node server/index.mjs
curl http://127.0.0.1:8899/api/pay/plans   # channels 为 false 表示密钥未配
```

---

## 八、已知问题 / 待办

### 待决策

- **`autoBang` 默认开启**，每单多花 0.5 credit（成本翻倍）。关掉能把单次成本从 ¥5.3 降到 ¥2.7，但车身拆解是"换轮毂"功能的数据前提，需先确认真实依赖再改。

### 待实现

- 退款接口（目前只能去商户后台手动退）
- 超时关单定时任务（未支付订单会一直挂在 `pending`）
- 额度扣减改为「生成成功后再扣」（现在是先扣后用，生成失败会白扣一次）

### 环境风险

- **备案期间禁止解析域名**。2026-11 首次备案因「域名指境外 Fly IP + 网站可访问」被驳回；现已清空所有 A/AAAA 记录，重新提交中。任何解析变更都要等备案通过后再做。
- **Fly 上的数据是孤本**。Fly 卷 `inspire_car_data` 里的用户/订单/额度数据比本地 `.cache` 新，关停 Fly 前必须先按 `MIGRATE_TO_CN_SERVER.md` 5.2 导出，否则会丢。
- 导出的 `.cache` 内含 `.cache/users/.secret`（会话签名密钥），**不可外传、不可提交 git、不可发群**。
- 模型总体积约 37MB（`base-high-pbr.glb` 18M + `base-high-shaded.glb` 12M + 7 个轮毂），迁移后建议开 Nginx / Caddy 的 gzip + 长缓存，否则国内首屏仍慢。

---

## 九、部署

**唯一生产环境：腾讯云轻量服务器（中国大陆境内），Docker + docker-compose。**

| 环境 | 状态 | 说明 |
|---|---|---|
| 腾讯云 `62.234.134.252` | ✅ **目标环境** | ICP 备案通过后启用，步骤见 `MIGRATE_TO_CN_SERVER.md` |
| Fly.io（`sin` 新加坡） | ⛔ **已废弃，待关停** | 境外节点，备案必然驳回；`fly.toml` / `FLY_DEPLOY.md` 仅作历史留存 |
| Railway / Zeabur | ⛔ **已废弃** | `railway.toml`、`ZEABUR_DEPLOY.md` 仅作历史留存 |

> **为什么放弃 Fly**：它跑的是同一个 `Dockerfile`，本质是「一台境外虚拟机 + 一块持久卷」，当初选它是为了绕开 Railway 到期收费。但 ICP 备案硬性要求服务器在**境内**且接入商与备案服务商一致，域名指境外 IP 直接驳回（2026-11 已实际发生一次）。所以生产环境**只能用腾讯云**，不要再往 Fly / Railway / Zeabur 部署。

### 9.1 当前部署状态（2026-11-06）

- 域名 `www.inspire-car.com` / `inspire-car.com` 的 A / AAAA 记录**已全部清空**，公共 DNS 返回 `NXDOMAIN`
- 备案**已重新提交审核中** → 期间保持「域名无解析 + 服务器不对外」，**不要加回任何解析（尤其不能指回 Fly 境外 IP）**，否则二次驳回
- Fly 应用 `inspire-car` **仍在运行**，持久卷 `inspire_car_data` 中有线上真实数据（用户 / 订单 / 额度 / 生成的 GLB），**关停前必须先导出**，见 `MIGRATE_TO_CN_SERVER.md` 第 5 节

### 9.2 迁移到腾讯云（备案通过后）

完整步骤见 `MIGRATE_TO_CN_SERVER.md`（含 Docker 安装、`.env` 密钥、数据搬迁、Caddy 自动 HTTPS、验证清单、常见坑）。要点：

- 单端口 8080，`server` 同时服务 `dist/` 静态产物与 `/api/*`
- 持久卷挂载到 `/app/.cache`（**用户数据都在这里，别动**）
- 敏感 key 全部走 `.env`，**绝不写进任何会提交到 git 的文件**（环境变量清单见第五节）
- `Dockerfile` 是 `COPY . .` + `npm run build`，新增文件自动进镜像

### 9.3 上线前必改的两处

1. `public/sw.js` 的 `CACHE = 'inspire-car-v1'` → **`v2`**。否则老用户会被 Service Worker 缓存喂旧版本（这正是"服务器关了网站还能打开"的原因）。
2. `PAY_ENFORCE` 在 `WXPAY_*` / `ALIPAY_*` 密钥配好之前保持 `0`。此时付费闸门关闭、免费流程正常；密钥填好并验过 0.01 元支付后再改 `1`，否则用户点付款只会看到「通道未配置」。

---

## 十、给 AI 助手的协作规则

1. **改之前先 `git status`。** 这个仓库刚建立版本控制，是你的安全网。
2. **不要引入三方依赖**，除非用户明确要求——见第二节铁律 1。
3. **新增数据操作必须写双模式**（PG + JSON）——见第二节铁律 3。
4. **不要动 `.cache/` 里的数据文件**，那是线上用户的真实数据镜像。
5. **改完必须跑 `npm run build`**，构建不过等于没交付。
6. **改车辆参数逻辑后跑 `npm run verify`**，7 个校验脚本会抓出数学错误。
7. **不要在代码里硬编码任何密钥**，全部走环境变量。

---

## 十一、版本控制基线与回滚

本仓库于 2026-11-03 初始化 git，交接锚点为 tag **`handoff-2026-11-03`**。

```
429bd82  chore: 加 .gitattributes 锁定换行符     ← 交接锚点（tag 指向这里）
be0f7af  chore: 增加一键回滚脚本 handoff-restore.sh
9a2982c  chore: 建立版本控制基线（218 文件 / 54,533 行）
```

### 回滚工具（`scripts/handoff-restore.sh`）

四档模式，**默认档是只读的**，不会误伤：

```bash
bash scripts/handoff-restore.sh check    # 只读：列出当前与锚点的全部差异（默认）
bash scripts/handoff-restore.sh backup   # 把当前状态另存为 pre-restore-<时间戳> 分支
bash scripts/handoff-restore.sh soft     # 只丢弃未提交改动，保留你的提交
bash scripts/handoff-restore.sh hard     # 彻底回到锚点（提交也丢）
```

**`soft` 和 `hard` 都会先自动创建 `pre-restore-<时间戳>` 分支**，所以即使回滚错了，也能 `git checkout pre-restore-xxx` 找回。

### 手动回滚（不依赖脚本）

```bash
git checkout .                        # 丢弃未提交改动，最简单
git reset --hard handoff-2026-11-03   # 连提交一起回到锚点
git fetch --tags origin               # tag 丢了从远程补
```

### 三层恢复能力

| 层级 | 位置 | 适用场景 |
|---|---|---|
| L1 | 本地 git（tag + 分支） | 日常改坏，秒级回滚 |
| L2 | GitHub `backup/2026-11-03` 分支 | 本地 `.git` 被删，重新 clone |
| L3 | 本地快照 zip / tar.gz（含 `.cache` 用户数据） | 一切都没了 |

### 给接手方的硬边界

- **不要删除 `.git` 目录**，那是唯一的一层即时回滚能力。
- **不要 `git push --force`** 到 `backup/2026-11-03`，会抹掉锚点。
- **不要改写 tag `handoff-2026-11-03`**，它是回滚目标点。
- 如果确实要重构历史，先 `git tag redesign-<日期>` 另起一个点，保留原锚点。

