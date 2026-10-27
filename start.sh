#!/bin/bash
# 开源雷达 启动脚本
# 用法：./start.sh                     默认 http://127.0.0.1:8788
#      PORT=9000 ./start.sh            换端口
#      GITHUB_TOKEN=xxx ./start.sh     带 token（匿名 60 次/小时，token 5000 次/小时）
#      ./start.sh --force              仅当占用者是本项目时，重启它
set -euo pipefail
cd "$(dirname "$0")"

FORCE=0
for a in "$@"; do
  case "$a" in
    --force|-f) FORCE=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "未知参数：${a}（支持 --force / -f / --help）" >&2; exit 2 ;;
  esac
done

# PORT 来自环境变量，非数字/越界时提前拦下，别等 bind 失败
PORT="${PORT:-8788}"
case "$PORT" in
  ''|*[!0-9]*) echo "PORT 必须是数字，当前：$PORT" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "PORT 超出范围 1-65535，当前：$PORT" >&2; exit 2
fi

BUN="${BUN:-$HOME/.bun/bin/bun}"
if [ ! -x "$BUN" ]; then
  if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)";
  else echo "找不到 bun，请先安装：curl -fsSL https://bun.sh/install | bash"; exit 1; fi
fi

if ! command -v lsof >/dev/null 2>&1; then
  echo "找不到 lsof，无法检查端口占用。请先安装（macOS 自带；Linux: apt install lsof）" >&2
  exit 1
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

# 只查 TCP 监听者。不带 -sTCP:LISTEN 会把「8788 是远端端口」的普通连接也算进来，
# 那样 --force 会杀掉完全无关的客户端进程。
LISTENERS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$LISTENERS" ]; then
  echo "端口 $PORT 已被占用（PID: $(echo $LISTENERS | tr '\n' ' '))"
  SELF=0
  for p in $LISTENERS; do
    cmd="$(ps -p "$p" -o command= 2>/dev/null || echo unknown)"
    echo "  $p  $cmd"
    case "$cmd" in *server.mjs*) SELF=1 ;; esac
  done
  if [ "$SELF" != "1" ]; then
    # 占用者不是本项目：即便 --force 也不动它
    echo "→ 占用者不是本项目，不结束任何进程。换端口：PORT=8899 ./start.sh" >&2
    exit 1
  fi
  if [ "$FORCE" != "1" ]; then
    echo "→ 本项目已在运行。要重启请加 --force："
    echo "  GITHUB_TOKEN=xxx ./start.sh --force"
    echo "→ 或换端口：PORT=8899 ./start.sh"
    exit 1
  fi
  echo "→ --force：结束本项目的旧实例"
  echo "$LISTENERS" | xargs kill 2>/dev/null || true
  sleep 1
  STILL="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$STILL" ]; then
    echo "$STILL" | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi
  # 确认端口真的释放了，否则带着占用去 bind 只会得到一句晦涩的错误
  if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "端口 $PORT 仍被占用，启动中止" >&2
    exit 1
  fi
fi

echo "启动 http://127.0.0.1:$PORT"
exec "$BUN" server.mjs
