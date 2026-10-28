#!/bin/sh
# 启动入口：兼容群晖 / 威联通 / unraid 这类宿主目录由 root 拥有的场景。
#
# 为什么需要它：NAS 上映射进来的 /data 通常是 root:root。若镜像硬写
# USER bun（uid 1000），进程写库会直接 fatal（unable to open database file），
# 用户在 NAS 图形界面里只看到容器反复重启，看不出是权限问题。
#
# 做法：以 root 进入 → 修正数据目录属主 → 用 su 降权到 PUID/PGID（默认 1000）
# 再执行命令。进程最终不以 root 运行。
# 设 PUID/PGID 可对齐宿主 uid（群晖用户一般从 1026 起；不改的话宿主要 sudo 才能读库文件）。
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"

# 无参数时给默认命令，等价于镜像原来的 CMD
[ "$#" -gt 0 ] || set -- bun server.mjs

if [ "$(id -u)" != "0" ]; then
  # 已被 --user 指定为非 root（或 compose 里设了 user:）：尊重调用方
  exec "$@"
fi

mkdir -p "$DATA_DIR"

# 只在属主不符时才递归 chown：库有几百 MB 时每次启动都 chown 会明显变慢
if [ "$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || echo '')" != "$PUID:$PGID" ]; then
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || \
    echo "[warn] 无法修改 $DATA_DIR 属主（只读挂载或 NFS root_squash？），若启动失败请检查挂载权限"
fi

# 找一个能代表 PUID 的账号名：优先复用镜像内已有的，否则临时补一条 passwd
RUNAS="$(awk -F: -v u="$PUID" '$3==u {print $1; exit}' /etc/passwd)"
if [ -z "$RUNAS" ]; then
  RUNAS="radar"
  echo "$RUNAS:x:$PUID:$PGID:radar:$DATA_DIR:/bin/sh" >> /etc/passwd
  awk -F: -v g="$PGID" '$3==g {f=1} END {exit !f}' /etc/group || \
    echo "radar:x:$PGID:" >> /etc/group
fi

# 逐参数加单引号，避免带空格的参数被 sh 拆开
CMD=
for a in "$@"; do
  CMD="$CMD '$(printf '%s' "$a" | sed "s/'/'\\\\''/g")'"
done

# HOME 指向数据目录：/root 在降权后不可写，bun 放缓存会失败
exec su "$RUNAS" -s /bin/sh -c "HOME='$DATA_DIR'; export HOME; exec$CMD"
