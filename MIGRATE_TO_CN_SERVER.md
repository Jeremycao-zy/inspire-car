# 灵感改装 / INSPIRE CAR —— 从 Fly.io 迁移到中国大陆服务器

> 适用对象：个人开发者，中等技术水平，能照着命令敲。
> 目标：ICP 备案通过后，把 `inspire-car`（Fly.io 新加坡 sin，公网 `https://inspire-car.fly.dev`）整套搬到一台**中国大陆境内**的 Docker 服务器。
> 本文件里所有 `<尖括号>` 占位符都需要你替换成自己的真实值。

---

## 0. 什么时候做这件事（顺序别搞反！）

**必须先 ICP 备案通过、且域名解析可用，再搬家。** 顺序反了会白干：

1. **先备案**：中国大陆管局要求备案主体必须有一台**境内服务器**（境外的 Fly.io 新加坡节点不算）。所以你买境内机器、提交备案，是**为了拿备案号**，不是为了先跑服务。
2. **备案通过后再搬家**：等备案号下来、域名（如 `www.inspire-car.com`）解析到你这台境内机器之后，再执行本文第 3～8 节的迁移。
3. 搬家期间 Fly.io 那台**先别删**，等国内跑稳了、验证清单全过，再下线 Fly 以省心省钱。

> 为什么不能反过来：没备案就把域名指向境内服务器并提供公开访问，管局会**阻断访问**甚至注销备案。所以"先有境内服务器用于备案 → 备案通过 → 再切流量"。

---

## 1. 买什么样的机器（最省钱）

备案要求：服务器**包月 ≥ 3 个月**（备案系统会校验实例到期时间，不足 3 个月不予通过），且必须是**中国大陆地域**的实例。

推荐（按省钱优先）：

| 项目 | 建议 | 说明 |
|---|---|---|
| 厂商 | 腾讯云 / 阿里云的**轻量应用服务器**（活动机最便宜） | 个人开发者首选，控制台简单，自带防火墙（安全组） |
| 规格 | **2 核 4G**（2C4G） | 你计划买的规格，够用 |
| 系统盘 | **≥ 60GB**（建议 80–100GB） | 生成的 GLB 模型单文件 12–44MB，.cache 会慢慢长大 |
| 计费 | **包月**（务必 ≥ 3 个月，否则备案不过） | 别选按量，备案不认 |
| 地域 | 任意**中国大陆境内**节点即可，按离你和你的用户近的选（广州 / 上海 / 北京 等） | 见下方说明 |
| 镜像 | 选 **Ubuntu 22.04 LTS** 或 **Debian 12** | 本文命令按这两个发行版写 |
| 带宽 | 轻量一般给固定峰值带宽（如 6–8Mbps），够个人站 | 大文件下载慢点但能用 |

> **地域不需要和主体所在地一致**（常见误解）：服务器地域只是机器放在哪个机房，随便选境内节点，按延迟/价格挑就行。
> 真正决定备案归属的是**备案主体**：你这次是做小程序，主体是**个体工商户 / 公司**，所以备案系统里选的"备案省份"按**营业执照上的注册地**填，由该省通信管理局审核——这跟服务器机房在哪个城市是两回事，不用刻意凑到一起。

价格**以活动页为准**，不要凭记忆。先看官方活动页再下单：
- 腾讯云轻量应用服务器活动：<https://cloud.tencent.com/act/pro/lighthouse2023> （或官网产品页 <https://cloud.tencent.com/product/lighthouse>）
- 阿里云轻量应用服务器：<https://www.aliyun.com/product/swas>

> 价格随活动变动，本文件不写具体金额，下单前以页面显示为准。

---

## 2. 服务器上装什么

### 2.1 装 Docker + Docker Compose

以下命令在**新服务器的终端**里执行（Ubuntu 22.04 / Debian 12 通用）：

```bash
# 1) 一键安装 Docker（含 compose 插件）。脚本会检测系统，失败会提示。
curl -fsSL https://get.daocloud.io/docker | bash
# 上面若网络不通，改用官方脚本：
# curl -fsSL https://get.docker.com | sh

# 2) 把当前用户加入 docker 组，免去每次 sudo（执行后重登终端生效）
sudo usermod -aG docker $USER

# 3) 启动并设置开机自启
sudo systemctl enable --now docker

# 4) 验证安装成功（应能看到版本号，且下面 hello-world 能跑）
docker --version
docker compose version
docker run --rm hello-world
```

> 这条干什么：装好容器运行时。失败会怎样：`docker: command not found` 或 `hello-world` 拉不下来 → 多半是网络问题，换上面另一个安装脚本或检查服务器 DNS/代理。

### 2.2 防火墙 / 安全组要开的端口

在云厂商控制台（安全组 / 防火墙）放行：

| 端口 | 协议 | 用途 | 是否必须 |
|---|---|---|---|
| `80`  | TCP | HTTP（Caddy 自动申请/续期 HTTPS 时需要，且做 80→443 跳转） | 必须 |
| `443` | TCP | HTTPS（用户最终访问） | 必须 |
| `8080`| TCP | 应用实际监听端口，**仅在内网/本机用**；若你让 Caddy 与容器同机，外部无需直接开 8080 | 见说明 |

> 说明：本文第 6 节用 Caddy 反代，Caddy 跑在宿主机、转发到容器 `127.0.0.1:8080`。因此**外网只需 80/443**；8080 不必对公网开放（更安全）。只有当你要直连调试时，才临时开 8080。

---

## 3. 把代码搬过去

### 3.1 最省事：在服务器上直接 git clone（推荐）

服务器上已经装好 git 和 docker 即可：

```bash
# 在服务器上，进入你放项目的目录（如 /opt）
cd /opt
git clone git@github.com:Jeremycao-zy/inspire-car.git garage-vite
cd garage-vite
```

> 这条干什么：把代码拉到服务器。`git clone` **天然排除** `node_modules/`、`.cache/`、`.git/`、`.env`，不会把本地的依赖、数据、密钥带上去。失败会怎样：SSH key 没配 → 提示 `Permission denied`，需要把服务器的公钥加到 GitHub；或改用 https 地址。

### 3.2 备选：从你 Mac 打包 scp 上去

如果不用 git，从项目根目录打包（排除不需要的目录）：

```bash
# 在 Mac 的项目根目录执行：排除 node_modules / .cache（含数据，不传） / .git / dist（服务器会重新构建） / .env（含密钥，不传）
tar --exclude=node_modules --exclude=.cache --exclude=.git \
    --exclude=dist --exclude=.env --exclude='.env.*' \
    -czf garage.tgz .

# 传到服务器（替换成你的服务器 IP 和用户名）
scp garage.tgz <你的服务器用户名>@<你的服务器IP>:/opt/garage.tgz

# 在服务器上解压
ssh <你的服务器用户名>@<你的服务器IP>
mkdir -p /opt/garage-vite && tar -xzf /opt/garage.tgz -C /opt/garage-vite
```

> 排除说明：`node_modules` 和 `dist` 会在 Docker 构建时重新生成；`.cache` 是运行时数据（见第 5 节单独迁移）；`.env` 含密钥绝不能传。失败会怎样：tar 报 `file is the archive` 之类 → 确认排除项没把自己包进去；scp 超时 → 检查安全组是否放行了 22 端口（SSH）。

---

## 4. 构建与启动

项目根已提供 `docker-compose.yml`（本次随文档新增）。它把端口、卷挂载、环境变量都写好了。

### 4.1 准备密钥文件 `.env`（绝不进 git）

在项目根目录创建 `.env`（**.env 已在 .gitignore 忽略，不会被提交**），只放密钥与可选覆盖：

```bash
# 在服务器项目根目录
cat > .env <<'EOF'
# ===== 密钥（不进 git，值从 Fly 原 secrets 抄过来）=====
# ⚠️ 全部先留空！下面每条等号后面什么都别写。
#    留空 = 该能力走 demo/关闭，站点照样能起来。
#    **千万别直接照抄 <...> 这种占位文字**——那会被当成真 key 传进去，
#    结果不是降级到 demo，而是拿假 key 去请求、全部 401 报错。
#    等你拿到真 key 了，再逐行把等号后面填上（直接 vi .env 改即可）。
#
# Hyper3D (Rodin/BANG) 商业 API Key
HYPER3D_API_KEY=
# 混元 3D 凭证
HUNYUAN3D_TOKEN=
# 车型识别视觉模型 key（qwen/dashscope/bailian 任一）
QWEN_API_KEY=
# fal.ai
FAL_KEY=
# 微信小程序登录（要小程序登录才配）
WECHAT_APPID=
WECHAT_SECRET=
# 微信/苹果 OAuth 网站登录
# APPLE_CLIENT_ID=

# ===== 仅当你决定用 PostgreSQL 时才填（默认不用，走 JSON 模式）=====
# DATABASE_URL=postgres://inspirecar:inspirecar@db:5432/inspirecar
# AUTH_SECRET=<用 openssl rand -hex 48 生成的固定随机值>
EOF
```

> 这条干什么：把密钥与敏感配置集中到 `.env`，compose 用 `env_file` 注入容器，源码和 git 里都不出现明文。
>
> **这一步不能跳过，文件必须存在（全空也行）**：compose 的 `env_file` 默认是必填的，.env 不存在时 `docker compose up` 会直接报错 `env file .env not found`，容器根本起不来。你现在还没从 Fly 抄过来也没关系——先全空，站点照样能跑（3D 生成走 demo，其余功能不受影响），等拿到 key 再填。
>
> 其他失败情况：`DATABASE_URL` 填错 → 启动回退 JSON 模式并打警告（不影响站点启动）。

> 从 Fly 把现有密钥抄过来（可选，省得手抄）：
> ```bash
> # 在你 Mac 上跑，会列出 Fly 上已设置的密钥名（值不显示）
> ~/.fly/bin/flyctl secrets list --app inspire-car
> # 值只能逐个去看，用你当时设置的值填进服务器上的 .env
> ```

### 4.2 构建并启动

```bash
cd /opt/garage-vite

# 保险一步：确保 .env 存在（跳过 4.1 也能起来，就是 3D 走 demo）
[ -f .env ] || touch .env

# 构建镜像并后台启动（-d 后台；--build 每次都重新构建前端）
docker compose up -d --build

# 看日志（确认 "API 服务已启动" 且 "静态资源：已开启"）
docker compose logs -f inspire-car
```

> 这条干什么：用 Dockerfile 构建（内部会 `npm install` → `npm run build` → `npm prune`），然后起容器，监听容器内 8080，并把 `/app/.cache` 挂到名为 `inspire_car_data` 的持久卷。失败会怎样：
> - `npm install` 失败 → 多半是网络拉不动 npm 包，给服务器配 npm 镜像或代理；
> - 构建卡在 `npm run build` → 看日志是不是前端报错；
> - 容器起不来 → `docker compose logs inspire-car` 看具体错误。

### 4.3 环境变量速查（哪些是必填 / 选填 / 密钥）

| 变量 | 必填？ | 类型 | 说明 |
|---|---|---|---|
| `NODE_ENV=production` | 必填 | 非密钥 | compose 已写死 |
| `HOST=0.0.0.0` | 必填 | 非密钥 | 容器内必须监听 0.0.0.0，否则外部访问不到（compose 已写） |
| `PORT=8080` | 必填 | 非密钥 | 应用监听端口；也可被 `API_PORT` 覆盖（默认 8787） |
| `SERVE_STATIC=1` | 必填 | 非密钥 | 让后端顺带托管 `dist/`（compose 已写） |
| `SPA_FALLBACK=1` | 必填 | 非密钥 | 未知路径回落 `index.html`（compose 已写） |
| `MAX_BODY_MB` | 选填 | 非密钥 | 请求体上限，默认 80 |
| `MAX_POLL_MS` | 选填 | 非密钥 | 生成最长轮询，默认 ~15 分钟 |
| `POLL_INTERVAL_MS` | 选填 | 非密钥 | 轮询间隔，默认 5000 |
| `PUBLIC_BASE_URL` | 选填 | 非密钥 | 前端/OAuth 回跳基地址，同源时不用改 |
| `ADMIN_UIDS` | 选填 | 非密钥 | 资讯发布管理员白名单 |
| `DATABASE_URL` | 选填 | **密钥** | PostgreSQL 连接串；不填则走本地 JSON 模式 |
| `AUTH_SECRET` | 选填* | **密钥** | 用 Postgres 时必须固定，否则重建后用户被踢下线 |
| `HYPER3D_API_KEY` / `HUNYUAN3D_TOKEN` / `QWEN_API_KEY` / `FAL_KEY` / `WECHAT_*` / `APPLE_CLIENT_ID` | 选填 | **密钥** | 各引擎/登录凭证，不配则对应能力走 demo/关闭 |

> *`AUTH_SECRET` 仅在启用 PostgreSQL 时为必填。

---

## 5. 数据迁移（从 Fly.io 持久卷搬下来）

### 5.1 先确认 Fly 上数据存在哪（重要）

本项目**没有 SQLite 文件**。数据持久化有两种模式，**取决于 Fly 上是否设置了 `DATABASE_URL`**：

- **没设 `DATABASE_URL`**（Fly 免费档默认）→ **JSON 模式**：账号、方案、论坛、上传、生成的 GLB 全部在 Fly 持久卷的 `/app/.cache` 里（子目录 `users/ wheels/ plans/ otp/ forum/ news/ models/ uploads/forum/`）。
- **设了 `DATABASE_URL`**（挂了 Postgres 插件）→ **SQL 模式**：账号/方案/论坛在 Postgres；`/app/.cache` 只存生成的 GLB 模型与论坛上传文件。

> ⚠️ **未确认**：你的 Fly 实际上有没有开 Postgres？请在能访问 flyctl 的机器上核对：
> ```bash
> fly secrets list -a inspire-car
> ```
> 若列表里有 `DATABASE_URL`，说明是 SQL 模式，第 5.3 节要额外做；若没有，就只用 5.2 搬 `.cache` 即可。

### 5.2 搬 `/app/.cache`（JSON 模式 / 或 SQL 模式下的 GLB+上传）

在**本地 Mac**（已登录 flyctl）执行，把 Fly 卷打包拉回：

```bash
# 1) 进 Fly 机器，把 /app/.cache 打成 tar（容器内只打包数据目录，别打包 node_modules）
flyctl ssh console -a inspire-car -C "tar czf /tmp/cache.tgz -C /app .cache"

# 2) 把 tar 拉到本地
flyctl ssh sftp get /tmp/cache.tgz ./cache-from-fly.tgz -a inspire-car
```

再把 `cache-from-fly.tgz` 传到新服务器，并灌进 Docker 卷：

```bash
# 传到服务器
scp cache-from-fly.tgz <你的服务器用户名>@<你的服务器IP>:/opt/cache-from-fly.tgz

# 在服务器上：先确保容器和卷已创建（up 过一次即可），再把数据解压进卷
ssh <你的服务器用户名>@<你的服务器IP>
cd /opt/garage-vite
docker compose up -d   # 确保卷 inspire_car_data 已存在
# 用临时容器把数据写进卷（busybox 一定可用）
docker run --rm -v inspire_car_data:/data -v /opt/cache-from-fly.tgz:/src/cache-from-fly.tgz busybox \
  tar xzf /src/cache-from-fly.tgz -C /data
# 重启应用让数据生效
docker compose restart inspire-car
```

> 这条干什么：把 Fly 卷里的 `.cache` 原样搬进国内服务器的持久卷。失败会怎样：
> - `flyctl ssh console` 连不上 → Fly 机器可能在休眠（min_machines_running=0），先访问一次 `https://inspire-car.fly.dev` 把它唤醒，或显式 `flyctl machines start`；
> - 数据没生效 → 确认卷名是 `inspire_car_data`（与 compose 一致），且解压后 `/data/.cache/...` 结构正确。

### 5.3 如果用的是 Postgres（SQL 模式，仅当 5.1 确认有 DATABASE_URL）

```bash
# 在本地用 flyctl 代理到 Fly 的 Postgres，pg_dump 导出
flyctl postgres connect -a <你的fly-pg-app>   # 或在 Fly 机器内直接用 psql
# 导出（示例，需替换为你的库名/用户）：
pg_dump -h <fly-pg-host> -U <user> <dbname> > fly-db.sql
```

然后在国内用本文 compose 注释里的 `db` 服务（或云 Postgres），`psql ... -f fly-db.sql` 导入，并在 `.env` 填好 `DATABASE_URL` 与固定的 `AUTH_SECRET`。

### 5.4 取舍：数据不重要就直接重建

如果这只是个人 Demo、历史数据无所谓，**最省事的做法是跳过 5.2/5.3**：直接 `docker compose up -d --build`，Docker 卷会自动初始化空目录，首次启动无用户、无历史方案，但站点功能完全正常（还能用离线演示模式）。生成的新模型、新注册用户都会正常落到新卷。

---

## 6. 域名 + HTTPS

备案通过后，把域名（如 `www.inspire-car.com`）**A 记录**指向这台服务器的**公网 IP**。

### 6.1 用 Caddy 自动拿免费 HTTPS（最省心，自动续期）

Caddy 会自动申请并续期 Let's Encrypt 证书，不用手动管。

```bash
# 在服务器上安装 Caddy（Ubuntu/Debian 官方一键脚本）
curl -fsSL https://get.caddy.com | bash
```

> 安装失败会怎样：若一键脚本不通，按 Caddy 官网 Debian/Ubuntu 安装文档操作（<https://caddyserver.com/docs/install>），以官网为准。安装后 `caddy version` 应能看到版本号。

创建 Caddyfile（`/etc/caddy/Caddyfile`）：

```caddy
# 替换成你的域名
www.inspire-car.com {
    # 反向代理到同机容器（compose 已映射 8080 到宿主机）
    reverse_proxy 127.0.0.1:8080
}

# 若你还要用根域名 inspire-car.com 访问，加一条：
# inspire-car.com {
#     reverse_proxy 127.0.0.1:8080
# }
```

```bash
# 启动 Caddy 并开机自启
sudo systemctl enable --now caddy
# 改完配置后重载
sudo systemctl reload caddy
```

> 这条干什么：Caddy 监听 80/443，把公网请求转给容器里的 8080，并自动申请 HTTPS。失败会怎样：
> - 证书申请失败 → 多半是域名没正确 A 记录解析到本机，或 80 端口被占用；`sudo journalctl -u caddy -e` 看日志；
> - 访问 502 → Caddy 起来了但容器没起 / 端口不对，回到第 4 节确认容器在跑。

### 6.2 公安备案提醒（域名备案后必做）

ICP 备案（管局）通过后，**30 日内**还要做**公安备案**（全国互联网安全管理服务平台 `www.beian.gov.cn`）。不做会被通报整改。这是管局备案之外的另一道手续，别漏。

---

## 7. 小程序侧要跟着改什么

项目里小程序相关文件：`miniprogram/app.js`、`miniprogram/project.config.json`。

### 7.1 改 `miniprogram/app.js` 的三个常量

打开 `miniprogram/app.js`，把顶部 `CONFIG` 里的：

```js
API_BASE: 'https://inspire-car.fly.dev',   // ← 改成 https://www.inspire-car.com
WEB_BASE: 'https://inspire-car.fly.dev',   // ← 改成 https://www.inspire-car.com
STUDIO_PATH: '/',                          // ← 保持 '/'，别改（见下方坑）
```

改成你的新域名，**两个都改**，其余代码不动。`STUDIO_PATH` 保持 `'/'`（历史上有"深链导致 502"的坑，详见第 9 节，保持根路径最稳）。

### 7.2 微信公众平台后台要同步加

登录 [微信公众平台](https://mp.weixin.qq.com) → 你的小程序 → **开发管理 → 开发设置**：

- **request 合法域名**：加上 `https://www.inspire-car.com`（API 请求用，必须是 https + 已备案域名，不能用 IP）。
- **业务域名（web-view 业务域名）**：加上 `https://www.inspire-car.com`（承载 3D 编辑器的 `<web-view>` 用）。

### 7.3 业务域名校验文件放哪（最容易搞错的一步）

微信要求：把 `MP_verify_xxxx.txt` 放到**域名根目录**，也就是 `https://www.inspire-car.com/MP_verify_xxxx.txt` 这个地址必须能直接打开、显示一串随机字符。

> ⚠️ **不要放进 `.well-known/`**。`.well-known/` 是 Let's Encrypt / Caddy 申请证书用的 HTTP-01 挑战路径，跟微信的校验文件是两套东西。放进去的话，`https://域名/MP_verify_xxxx.txt` 仍然取不到文件，微信会报"域名验证失败"。

两种方式，选一个：

**方式 A（推荐，不用重建容器）—— 交给 Caddy 直接返回：**

```bash
# 在服务器上建一个专门放微信校验文件的目录
sudo mkdir -p /opt/wx-verify
# 把你下载的校验文件放进去（文件名保持原样，一个字都别改）
sudo cp <你下载的 MP_verify_xxxx.txt> /opt/wx-verify/
```

然后把 `/etc/caddy/Caddyfile` 里 6.1 那个域名块**整块替换**成下面这样：

```caddyfile
www.inspire-car.com {
    # ① 微信业务域名校验文件：直接从本地目录返回，不转发给应用
    #    用 /MP_verify_* 做前缀匹配（通配写在末尾，Caddy 一定认）
    handle /MP_verify_* {
        root * /opt/wx-verify
        file_server
    }

    # ② 其余所有请求兜底转发给容器
    #    包一层 handle 是为了和上面互斥：命中的走①，没命中的才到这里
    handle {
        reverse_proxy 127.0.0.1:8080
    }
}
```

> 为什么写成两个 `handle`：`handle` 之间是互斥的，第一个命中的生效，且**不需要**你操心文件里的先后顺序（Caddy 会按指令优先级自动排序）。这样写最稳，不会哪天因为顺序调整导致校验文件被 `reverse_proxy` 抢走、又被 SPA 回落成 HTML 页面。

```bash
sudo systemctl reload caddy
# 自检：必须显示一串字符，而不是网页 HTML
curl -s https://www.inspire-car.com/MP_verify_xxxx.txt
```

**方式 B —— 放进前端 `public/`，重新构建：**

```bash
# 在服务器项目根目录。放 public/ 而不是 dist/：
# Vite 构建会把 public/ 整个拷进 dist/，下次构建也不会丢；直接丢 dist/ 会被覆盖。
cp <你下载的 MP_verify_xxxx.txt> public/
# 重新构建（让它进 dist/ 根目录）
docker compose up -d --build
```

> 为什么这样才对：本项目开了 SPA 回落（`SPA_FALLBACK=1`），**文件不存在时未知路径会回落成 `index.html` 并返回 200**。所以你访问 `https://域名/MP_verify_xxxx.txt` 时，如果看到的是一大段网页 HTML 而不是一串短字符，就说明文件没落到它该在的位置——微信校验必然失败。自检时务必 curl 看内容，别只看状态码是不是 200。

### 7.4 `project.config.json` 的 appid

`miniprogram/project.config.json` 里现在是占位 `"appid": "touristappid"`（游客模式）。正式发布必须换成你自己的小程序 **AppID**。

---

## 8. 验证清单（迁移完必做）

在服务器或本地，对**新域名**逐条 curl（全部应返回 200）：

```bash
# 1) 首页
curl -s -o /dev/null -w "%{http_code}\n" https://www.inspire-car.com/
# 期望：200

# 2) 不存在的深链（验证 SPA 回落没有 502）
curl -s -o /dev/null -w "%{http_code}\n" https://www.inspire-car.com/xyz-test-123
# 期望：200（回落到 index.html）

# 3) 健康检查接口
curl -s https://www.inspire-car.com/api/health
# 期望：返回一段 JSON，含 "ok":true；dbMode 应为 "json" 或 "sql"
```

> 三条都 200 才算迁移成功。若第 2 条是 502 → 见第 9 节"常见坑"，通常是 SPA 回落没生效或容器崩了。
> 也可直接用 IP+端口先验证容器本身：`curl -s http://<服务器IP>:8080/api/health`（需临时开 8080 安全组）。

---

## 9. 常见坑（来自代码实测的真实风险）

1. **端口不一致 / HOST 没设 0.0.0.0**
   应用端口优先级：`PORT` > `API_PORT`(默认 8787) > 8787，生产默认 **8080**。容器里 `HOST` 必须是 `0.0.0.0`，否则只监听回环、外部访问不到（curl 直接连接被拒）。compose 已固定 `HOST=0.0.0.0`、`PORT=8080`，**不要手改端口而不改 Caddy 的反代目标**。

2. **卷路径 `/app/.cache` 挂错**
   数据全在容器内 `/app/.cache`。compose 已挂到命名卷 `inspire_car_data`。若你改用 `-v /宿主机路径:/app/.cache`，注意路径权限：Node 以 root 跑一般没问题，但**别挂到 `/app` 根**，否则会盖掉代码。迁移数据时确认卷名一致（见第 5 节）。

3. **静态目录是 `dist/`，不是别的**
   后端只托管 `dist/`（`npm run build` 产物）。**不要在 compose 里把别的目录当静态根**。演示模型在 `public/models` 和 `dist/models`，构建后都在 `dist/models`。

4. **"未知路径导致 Node 进程崩溃、网关返 502"的历史 bug（已修，但教训要记）**
   之前 `server/static.mjs` 的 SPA 回落传了合成请求对象给文件流，`.on` 不存在 → 抛异常 → 进程死 → Fly 网关只回 **502**。修复后：① `server/static.mjs` 的 `pipeFile` 加了 `req.on` 存在性判断；② SPA 回落传真实 `req`；③ `server/index.mjs` 的 `handleRequest` 整体包了 `try/catch`，单请求异常变 500 而非崩进程。
   **教训**：容器务必加 `restart: unless-stopped`（compose 已加）+ 上面的 `healthcheck`，这样即使极端情况崩了也会自动拉起，不会长期 502。迁移后务必跑第 8 节第 2 条（深链 200）确认回落真的生效。

5. **JSON 模式 vs Postgres 别搞混**
   不设 `DATABASE_URL` 就走 JSON（数据在 `.cache`），设了就走 Postgres（数据在库）。**两种模式的数据位置不同，迁移方式也不同**（见第 5 节）。`AUTH_SECRET` 仅在 Postgres 模式必须固定，否则每次重建容器所有已登录用户被踢下线。

6. **`SERVE_STATIC` 没开 = 只跑 API、不托管前端**
   生产必须 `SERVE_STATIC=1` 且 `PORT` 一致，否则首页打不开（API 能通但静态 404）。compose 已默认开启。

7. **小程序 `STUDIO_PATH` 保持 `/`，原因不是 502**
   深链 502 已于 2026-10-15 修复（见第 4 条）。这里继续用 `'/'` 的真实原因是：**前端是单页应用且没有路由**，`/studio` 只是回落到同一个首页，不会打开别的页面。等前端哪天做了真路由（如 `#/studio`），再改这个常量，其余代码都不用动。

8. **微信校验文件别放 `.well-known/`（高频踩坑）**
   `MP_verify_xxxx.txt` 必须在**域名根目录**能直取（`https://域名/MP_verify_xxxx.txt`）。`.well-known/` 是 Let's Encrypt 申请证书走的路径，跟微信校验无关，放进去必然验证失败。另外本项目开了 SPA 回落，**文件缺失时返回的是 200 + 网页 HTML 而不是 404**，所以自检必须 curl 看内容是不是一串短字符，只看状态码 200 会被骗过去。详见 7.3。

9. **`.env` 别提交，且文件必须存在**
   密钥只在 `.env`，已被 `.gitignore` 忽略（`git add` 时确认没把它带进去）。同时注意：`env_file` 默认必填，`.env` 不存在时 `docker compose up` 会直接报 `env file .env not found` 而起不来——所以这一步不能跳过，全空也要有这个文件（见 4.1 / 4.2）。

---

## 附：关键事实速记（从代码确认）

- **基础镜像**：`node:22-slim`（Dockerfile）
- **暴露端口**：`8080`（Dockerfile `EXPOSE 8080`；fly.toml `internal_port = 8080`）
- **启动命令**：`node server/index.mjs`（Dockerfile `CMD`；生产需 `SERVE_STATIC=1`）
- **生产启动脚本**：`npm run build` → `node server/index.mjs`；`package.json` 的 `start` 已含 `SERVE_STATIC=1 SPA_FALLBACK=1`。**不需要 Vite dev server**。
- **静态目录**：`dist/`（`server/index.mjs` 中 `DIST_DIR`）
- **持久卷挂载点**：容器内 `/app/.cache`（fly.toml 卷名 `inspire_car_data` → `/app/.cache`）
- **数据文件**：`.cache/models/`（GLB + `index.json` + `bang-index.json` + `errors.log`）、`.cache/uploads/forum/`（论坛媒体）、`.cache/{users,wheels,plans,otp,forum,news}/`（JSON 模式下的账号/方案/论坛）。**无 SQLite**；有 `DATABASE_URL` 则走 Postgres。
- **健康接口**：`GET /api/health`（返回 `{"ok":true,...}`）
- **小程序**：`API_BASE` / `WEB_BASE` 在 `miniprogram/app.js`；`appid` 占位在 `miniprogram/project.config.json`
