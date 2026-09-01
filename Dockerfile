# 灵感车库 / Inspire Car — 生产单端口镜像
#
# 单端口：后端 node server 同时服务 dist/ 静态产物 + /api/*，
# 只需暴露一个端口（默认 8080），前后端不再分离部署。

FROM node:22-slim

# 系统依赖：无。server 只用 Node 内置模块 + https-proxy-agent，不需要编译工具链。
WORKDIR /app

# ---- 1) 依赖安装（先只拷清单，最大化 Docker 层缓存）----
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---- 2) 源码 + 构建前端 ----
COPY . .
RUN npm run build

# ---- 3) 去掉 devDependencies（vite 只在构建时需要，运行期不要）----
RUN npm prune --omit=dev

# ---- 4) 生产环境变量 ----
# SERVE_STATIC=1  让 server 顺带服务 dist/（默认关闭，本地 npm run dev 行为不受影响）
# SPA_FALLBACK=1  非 API 且文件不存在时回落 index.html
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SERVE_STATIC=1 \
    SPA_FALLBACK=1 \
    PORT=8080

# 生成任务单次最长 12 分钟轮询，请求体默认上限 80MB（传图 + GLB）
# 若平台有更严的超时/体积限制，用环境变量覆盖：
#   MAX_BODY_MB / MAX_POLL_MS / POLL_INTERVAL_MS
EXPOSE 8080

# .cache 存 GLB 模型、用户账号、额度计数 —— 必须在 Railway 控制台手动挂卷 /app/.cache
CMD ["node", "server/index.mjs"]
