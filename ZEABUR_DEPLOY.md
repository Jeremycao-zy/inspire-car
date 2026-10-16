# 灵感改装 · Zeabur 部署手册（免国际信用卡，支持支付宝/微信）

> 替代已失效的 Railway（Trial 到期）和需国际卡的 Fly.io。
> Zeabur：国内可**支付宝/微信**付款、GitHub 一键部署、能绑阿里云域名、直接读现有 `Dockerfile`。
> 免费额度有限（新用户有试用额度），正式长期跑按需付费，但**付款用国内卡即可**。

---

## 0. 前置：确保在 main 分支且已推

```bash
cd garage-vite
git checkout main
git push origin main
```

---

## 1. 注册并授权 GitHub（用支付宝/微信付款）

1. 打开 👉 **https://zeabur.com** ，点右上角 **Sign Up / 注册**
2. 用 **GitHub（Jeremycao-zy）** 授权登录
3. 进控制台后，按提示**绑定付款方式** → 选 **支付宝 / 微信**（国内扫码即可，无需双币卡）
   > 新用户有试用额度；超出后按量计费，从支付宝扣，不会要求你填 Visa。

---

## 2. 一键部署仓库

1. 控制台点 **"Create Project"（新建项目）** → 命名 `inspire-car`
2. 项目里点 **"Deploy New Service"（部署服务）** → 选 **GitHub** → 授权后选仓库 **`Jeremycao-zy/inspire-car`** → 分支选 **`main`**
3. Zeabur 自动识别根目录 `Dockerfile` → 开始构建（2–5 分钟）
4. 构建完会给一个默认域名，形如 `inspire-car.zeabur.app`

> 如果 Zeabur 没自动读到 `Dockerfile`，确认仓库根有 `Dockerfile` 和 `zeabur.json`（本仓库已备好）。

---

## 3. 设置环境变量 / 密钥（在 Zeabur 服务设置里填，不进仓库）

服务面板 → **Variables / 环境变量** 添加：

| 变量 | 值 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | |
| `HOST` | `0.0.0.0` | 容器监听所有网卡 |
| `SERVE_STATIC` | `1` | server 顺带服务 dist/ |
| `SPA_FALLBACK` | `1` | 非 API 回落 index.html |
| `PORT` | `8080` | 与 zeabur.json 一致 |
| `HYPER3D_API_KEY` | 你的 Key | 真实 3D 生成（可选，不填走 DEMO） |
| `HUNYUAN3D_TOKEN` | 你的 Token | 混元 3D（可选） |
| `QWEN_API_KEY` | `sk-xxx` | 车型识别 + 每日资讯（建议填；本地 `~/.workbuddy/tokens/qwen-vision` 首行即 key） |
| `ADMIN_UIDS` | 留空 | 资讯发布白名单（可选） |

> 不设 key 也能跑 DEMO 模式（界面/装配/调参全可用，只是不真消耗 3D 额度、资讯出英文原文）。
> **不设 `DATABASE_URL`** → 自动回退 `.cache` 本地 JSON（数据每次部署重置，个人 Demo 够用）。

改完变量 Zeabur 会自动重新部署。

---

## 4. 验证上线

部署完成后，在浏览器打开 Zeabur 给的 `https://inspire-car.zeabur.app`：
- `/` → 200
- `/api/health` → 200

把地址发助手，助手 curl 验证 `/` + `/api/health` + AI 接口。

---

## 5.（可选）绑阿里云买的自定义域名

1. Zeabur 服务面板 → **Domain / 域名** → 输入你的域名（如 `inspire-car.com`）
2. Zeabur 会显示一个 **CNAME 目标值**（形如 `xxx.zeabur.app` 或一条 CNAME 记录）
3. 阿里云控制台 → **域名 → 云解析 DNS** → 添加记录：
   - 类型 `CNAME`，主机记录 `@`（再补一条 `www`），记录值粘 Zeabur 给的 CNAME
4. 等 DNS 生效（几分钟~几十分钟），Zeabur 自动签发 HTTPS → `https://你的域名` 即可访问

---

## 6. 以后怎么更新

每次改完代码推到 main：
```bash
git checkout main
git push origin main
```
Zeabur 连了 GitHub 会**自动重新部署**（也可在面板点 Redeploy）。

---

## 7. 备选：Render（完全免卡，但会休眠）

如果你连支付宝都不想绑，可走 Render 免费档（**无需信用卡**，但空闲 15 分钟休眠、免费 Postgres 仅 30 天）：
- 👉 https://render.com → New → Web Service → 连 GitHub 仓库 `main` → 选 Docker → 部署
- 环境变量同第 3 步，在 Render 的 Environment 里填
- 免费档不休眠需升级 $7/月 Starter；免费档够 Demo 用

---

## 8. 常见问题

- **构建失败**：看 Zeabur 构建日志；多半是 `npm run build` 或 `npm ci` 报错，把日志发助手。
- **页面打不开 / 502**：确认 `PORT=8080` 且 server 读 `process.env.PORT`；Zeabur 注入的端口要和容器监听一致。
- **想持久化数据**：Zeabur 有持久化存储（付费），或接外部 PostgreSQL；免费档先不挂，接受数据重置。
