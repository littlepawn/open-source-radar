#!/bin/bash
# 开源雷达 启动脚本
# 用法：./start.sh                     默认 http://127.0.0.1:8788
#      PORT=9000 ./start.sh            换端口
#      GITHUB_TOKEN=xxx ./start.sh     带 token（匿名 60 次/小时，token 5000 次/小时）
#      ./start.sh --force              强制杀掉占用端口的旧进程再启动
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8788}"
FORCE=0
for a in "$@"; do [ "$a" = "--force" ] || [ "$a" = "-f" ] && FORCE=1; done

BUN="${BUN:-$HOME/.bun/bin/bun}"
if [ ! -x "$BUN" ]; then
  if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)";
  else echo "找不到 bun，请先安装：curl -fsSL https://bun.sh/install | bash"; exit 1; fi
fi

# token 只在环境变量里，不写文件、不打印内容
if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]; then
  echo "token: 已配置（5000 次/小时）"
else
  echo "token: 未配置 —— 匿名只有 60 次/小时，只能拿到最近一页。"
  echo "       建议：GITHUB_TOKEN=ghp_xxx ./start.sh"
  echo "       或在 https://github.com/settings/tokens 建 classic token（勾 public_repo）"
  [ -n "${RADAR_LOGIN:-}" ] || echo "       匿名模式还需指定读谁：RADAR_LOGIN=你的用户名"
fi

# 端口占用检查：先看清是谁，再决定是否接管
PIDS="$(lsof -ti ":$PORT" 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "端口 $PORT 已被占用（PID: $(echo $PIDS | tr '\n' ' '))"
  SELF=0
  for p in $PIDS; do
    cmd="$(ps -p "$p" -o command= 2>/dev/null || echo unknown)"
    echo "  $p  $cmd"
    case "$cmd" in *server.mjs*) SELF=1 ;; esac
  done
  if [ "$SELF" = "1" ] && [ "$FORCE" = "0" ]; then
    echo "→ 看起来是本项目已在运行。要重启请加 --force："
    echo "  GITHUB_TOKEN=xxx ./start.sh --force"
    echo "→ 或换端口：PORT=8899 ./start.sh"
    exit 1
  fi
  if [ "$FORCE" = "1" ]; then
    echo "→ --force：结束占用进程"
    echo $PIDS | xargs kill 2>/dev/null || true
    sleep 1
    STILL="$(lsof -ti ":$PORT" 2>/dev/null || true)"
    [ -n "$STILL" ] && echo $STILL | xargs kill -9 2>/dev/null || true
    sleep 0.5
  else
    echo "→ 占用者不是本项目，未擅自结束。换端口：PORT=8899 ./start.sh"
    exit 1
  fi
fi

echo "启动 http://127.0.0.1:$PORT"
exec "$BUN" server.mjs
