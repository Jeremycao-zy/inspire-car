#!/bin/bash
# 灵感车库 — 一键启动（macOS 双击此文件 / 或在终端执行 ./start-garage.command）
#
# 为什么需要它：
#   WorkBuddy 沙箱里启动的后台进程会被系统定期回收（实测活 1~10 分钟），
#   导致「页面能打开但一点生成就 502」。由**你自己终端**启动的服务不受这个限制。
#
# 这个脚本做了四件事，避免常见坑：
#   ① 不用 npm run dev（PATH 在双击时经常缺），直接用 node 绝对路径调 dev.mjs
#   ② 启动前释放 5173/8787 端口（避免残留进程占着）
#   ③ 等服务就绪再开浏览器（避免打开空白页）
#   ④ Ctrl+C 干净退出（不会留僵尸进程）

set -e

# 1) cd 到脚本所在目录（绝对路径，避免 macOS 双击时 $PWD 不对）
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# 2) 解除 macOS Gatekeeper 的 quarantine（首次双击提示"无法打开"时，执行一次即可）
xattr -d com.apple.quarantine "$0" 2>/dev/null || true

echo "=============================================="
echo "  灵感车库 · 启动中"
echo "  项目目录：$DIR"
echo "=============================================="

# 3) 释放端口（杀掉所有占 5173/8787 的进程）
for port in 5173 8787; do
  PIDS=$(lsof -ti :$port 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "端口 $port 被占用，正在释放（PID: $(echo $IDS | tr '\n' ' ')）..."
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
done

# 4) 用 node 绝对路径启动（不依赖 npm / PATH）
NODE=/Users/jeremysmac/.workbuddy/binaries/node/versions/22.22.2/bin/node
if [ ! -x "$NODE" ]; then
  echo -e "${RED}错误：找不到 node：$NODE${NC}"
  echo "请打开 WorkBuddy 设置，确认 node 22.22.2 已安装。"
  exit 1
fi

echo "启动 frontend(5173) + backend(8787) ..."
echo

# 前台跑（关窗口即停）
"$NODE" scripts/dev.mjs &
DEV_PID=$!

# 5) 等服务就绪（最多 30 秒）
echo "等待服务就绪 ..."
READY=0
for i in $(seq 1 30); do
  api=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:8787/api/health 2>/dev/null)
  web=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:5173/ 2>/dev/null)
  if [ "$api" = "200" ] && [ "$web" = "200" ]; then
    READY=1; break
  fi
  sleep 1
done

echo
if [ "$READY" = "1" ]; then
  echo -e "${GREEN}启动成功 ✅${NC}"
  echo
  echo "  访问地址：${GREEN}http://127.0.0.1:5173/${NC}"
  echo "  登录账号：uitest / uitest123"
  echo
  echo -e "  ${YELLOW}保持这个窗口开着，服务就会一直运行。${NC}"
  echo -e "  ${YELLOW}关闭窗口或按 Ctrl+C 即停止。${NC}"
  echo
  # 自动打开浏览器
  open http://127.0.0.1:5173/ 2>/dev/null || true
else
  echo -e "${RED}启动失败：服务未在 30 秒内就绪${NC}"
  echo "日志：/tmp/garage-dev.log（可手动 tail 排查）"
fi

# 6) 干净退出 + 保持窗口
trap 'echo; echo "正在停止服务..."; kill $DEV_PID 2>/dev/null || true; lsof -ti :5173 -ti :8787 2>/dev/null | xargs kill -9 2>/dev/null || true; echo "已停止。"; exit 0' INT TERM
wait $DEV_PID