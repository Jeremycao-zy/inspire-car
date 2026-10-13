# 灵感改装 · Fly.io 永久免费部署手册

> 解决 Railway Trial 到期（需 $5/月 + 国际信用卡）的问题。
> Fly.io：永久免费额度、免信用卡、不休眠、能绑自定义域名，跑的还是同一个 `Dockerfile`。
> 国内访客选香港节点（hkg），延迟最低。

---

## 0. 前置：确认在 main 分支

```bash
cd garage-vite
git checkout main        # 当前 main = feature/community = f2ba37a，已推 origin/main
```

---

## 1. 安装 flyctl（只需一次）

macOS（Homebrew）：
```bash
brew install flyctl
```
或官方脚本：
```bash
curl -L https://fly.io/install.sh | sh
```
装完确认：`flyctl version`

---

## 2. 登录（GitHub 授权，免信用卡）

```bash
flyctl auth login
```
浏览器弹出 → 用 GitHub 账号（Jeremycao-zy）授权即可。

---

## 3. 创建应用并部署

> `fly.toml` 已备好（app 名 `inspire-car`）。若提示名字被占用，改 `fly.toml` 里的
> `app = "你的唯一名"` 再跑。

```bash
# 建应用（若 fly.toml 的 app 名未被占用）
flyctl apps create inspire-car

# 部署（读 fly.toml → 构建 Dockerfile → 推到 hkg）
flyctl deploy
```

> 不想手动建应用也可直接 `flyctl launch`（会读 fly.toml，交互问 app 名/区域，选 hkg）。
> 部署完给的地址形如 `https://inspire-car.fly.dev`。

---

## 4. 填环境变量（敏感 key，只走 secrets，不进仓库）

从你本地 `.env` / 本地 token 文件复制：

```bash
# 取 qwen key（车型识别 + 每日资讯生成，强烈建议填）
head -1 ~/.workbuddy/tokens/qwen-vision

# 一次性设置所有 secrets（值换成你自己的）
flyctl secrets set \
  HYPER3D_API_KEY="你的Hyper3D_Key" \
  HUNYUAN3D_TOKEN="你的混元Token（可选，不填走DEMO）" \
  QWEN_API_KEY="sk-xxx" \
  ADMIN_UIDS=""
```

> 不设 key 也能跑：项目进 DEMO 模式（界面/装配/调参全可用，只是不真消耗 3D 额度、资讯出英文原文）。
> 设了 `DATABASE_URL` 才用 PostgreSQL；**免费档先不设** → 自动回退 `.cache` 本地 JSON（数据每次部署重置，个人 Demo 够用）。

设置 secrets 后 Fly 会自动重新部署一次。

---

## 5. 验证上线

```bash
flyctl open                 # 打开公网地址
flyctl logs                 # 看启动日志，确认无报错
```

在你本机（WorkBuddy 沙箱外）让助手 curl 验证：
- `https://inspire-car.fly.dev/` → 200
- `https://inspire-car.fly.dev/api/health` → 200
- 关键接口（如 `/api/chat`）应回真实模型

---

## 6.（可选）绑阿里云买的自定义域名

```bash
flyctl domains add 你的域名.com
flyctl domains add www.你的域名.com
```
Fly 会给出一个 CNAME / A 目标值 → 到阿里云控制台「域名 → 云解析」添加对应记录。
等 DNS 生效，Fly 自动签发 HTTPS → `https://你的域名.com` 即可访问。

---

## 7. 以后怎么更新

每次改完代码推到 main 后，本地：
```bash
git checkout main
flyctl deploy
```
（或想接 GitHub 自动部署：Fly 控制台 → 应用 → Settings → 连接仓库，设 main 分支自动部署。）

---

## 8. 常见问题

- **内存不够（OOM）**：把 `fly.toml` 的 `memory_mb = 256` 调成 `512`（仍属免费额度内），重跑 `flyctl deploy`。
- **想持久化用户/模型数据**：免费档挂卷要花钱，先不挂；真要持久再 `flyctl volumes create ...` 并加 `[mounts]`（参考 Dockerfile 注释里的 `/app/.cache`）。
- **换地区**：改 `primary_region`（nrt=东京 / sin=新加坡 / lax=美西），重跑 `flyctl deploy`。
