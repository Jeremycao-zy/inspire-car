# 灵感车库 · Railway 上架手册

单端口全栈镜像已就绪（`Dockerfile` + `railway.toml` + `server/static.mjs`）。
下面两种上架方式二选一，**方式 A 最省事（不用装 CLI）**。

---

## 前置准备

1. 一个 Railway 账号：https://railway.app （注册后有 $5 免费额度，够单人试用）
2. 真实 3D key（二选一或都配，不配也能跑 DEMO 模式）：
   - `HYPER3D_API_KEY` —— Hyper3D (Rodin / BANG) 商业 API Key
   - `HUNYUAN3D_TOKEN` —— 混元 3D 的 tempToken（`tk_` 开头）或 JWT
3. 代码已提交到本地 `main`（已 done）。上架需推到可访问的仓库，或用 CLI 直传。

---

## 方式 A：GitHub 连接部署（推荐，零 CLI）

1. 在 GitHub 新建一个空仓库（如 `inspire-car`），**不要**勾选 README。
2. 本地终端，进入项目目录：
   ```bash
   cd garage-vite
   git remote add origin https://github.com/<你的用户名>/inspire-car.git
   git push -u origin main
   ```
3. 打开 Railway 控制台 → **New Project** → **Deploy from GitHub repo** → 选中该仓库。
4. Railway 会自动读取 `railway.toml` + `Dockerfile` 构建并启动。
5. 进入项目 → **Variables**，添加（敏感，**只在控制台填**）：
   - `HYPER3D_API_KEY` = 你的 key
   - `HUNYUAN3D_TOKEN` = 你的 token
   （改完变量会自动重新部署）
6. 部署完成后，Railway 分配 `https://<项目名>.railway.app` 域名，浏览器打开即可。
7. **挂持久卷**（重要，否则重启丢用户数据）：
   项目 → **Volumes** → **Add Volume**，Mount Path 填 `/app/.cache`。

## 方式 B：Railway CLI 直连（不用 GitHub）

```bash
# 1. 安装 CLI（macOS）
brew install railway

# 2. 登录（浏览器授权）
railway login

# 3. 进入项目目录并关联/初始化
cd garage-vite
railway link        # 已有项目则选它；首次用 railway init 新建

# 4. 设置敏感环境变量（只在 Railway 侧，不进本地文件）
railway variables set HYPER3D_API_KEY=你的key
railway variables set HUNYUAN3D_TOKEN=你的token

# 5. 一键部署当前目录（读 railway.toml + Dockerfile）
railway up

# 6. 拿到公网域名
railway domain
```

---

## 验证上线是否成功

1. 打开 `https://<项目名>.railway.app/` —— 应看到车库 3D 界面。
2. 打开 `https://<项目名>.railway.app/api/health` —— 应返回 JSON，其中：
   - `"mode": "live"` 表示真实 key 生效；`"demo"` 表示走了离线预置（key 没配对）。
   - `engines` 字段显示各引擎 LIVE / DEMO 状态。
3. 在界面里上传一张车图 → 整车生成 → 应能调参、装配、切车壳。

---

## 关键配置说明（已内置，一般无需改动）

| 项 | 值 | 来源 |
|---|---|---|
| 监听地址 | `0.0.0.0` | `railway.toml` deploy.env + `Dockerfile` ENV |
| 服务端口 | `8080` | `Dockerfile` EXPOSE + `railway.toml` port |
| 健康检查 | `GET /api/health` | `server/index.mjs` |
| 静态服务 | 开（`SERVE_STATIC=1`） | `Dockerfile` ENV |
| SPA 回落 | 开（`SPA_FALLBACK=1`） | `Dockerfile` ENV |
| 持久化 | `/app/.cache` 挂卷 | `Dockerfile` VOLUME，需控制台挂 |

> 注意：本地 `start-garage.command` 仍走 `npm run dev`（HOST=127.0.0.1），不受影响；
> 只有 Railway/Docker 生产镜像才用 `0.0.0.0`，两边互不影响。

## 成本提示

- Railway 免费层 $5/月额度，超出按量计费；生成一次 3D 约 $0.4~$0.75（看引擎），注意监控。
- 不配 key 时永久 DEMO，不消耗任何额度，适合先验证网站可用性。
