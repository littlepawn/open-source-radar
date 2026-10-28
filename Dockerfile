# 开源雷达 · GitHub 收藏本地看板
# 零依赖，只用 Bun 内置运行时（Bun.serve + bun:sqlite），无 npm 安装步骤
#
# 国内拉不到官方镜像时，构建时覆盖基础镜像前缀即可：
#   docker build --build-arg REGISTRY=docker.m.daocloud.io/ -t open-source-radar .
ARG REGISTRY=
FROM ${REGISTRY}oven/bun:1.2-alpine

LABEL org.opencontainers.image.title="open-source-radar" \
      org.opencontainers.image.description="GitHub star/fork 本地看板：分类、中文简介、发现热门、新版本提醒，带登录鉴权" \
      org.opencontainers.image.source="https://github.com/littlepawn/open-source-radar" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 只拷贝运行所需文件，保持镜像精简
# lib/ 是 server.mjs 的 import 依赖（规则引擎 / AI 上下文 / 洞察计算），漏掉会启动即崩
COPY server.mjs ./server.mjs
COPY lib ./lib
COPY public ./public
COPY entrypoint.sh ./entrypoint.sh

# 数据目录：镜像内建好并交给 bun 用户写（挂载卷覆盖时仍可用）
# chmod a+rX：设了 PUID/PGID（如群晖 1026）时进程不是 bun，而 COPY 会保留
# 宿主的 0600 权限，不放宽会 EACCES reading /app/lib/*.mjs
RUN mkdir -p /data && chown -R bun:bun /app /data \
    && chmod +x /app/entrypoint.sh \
    && chmod -R a+rX /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    DATA_DIR=/data

# 以 root 启动只为在 entrypoint 里修正挂载目录属主，随后 setpriv 降权到
# PUID/PGID（默认 1000:1000），进程不以 root 运行。
# 群晖这类宿主目录归 root 的 NAS 上，硬写 USER bun 会因写不进 /data 而反复重启。
EXPOSE 8788
VOLUME ["/data"]

# 健康检查：未登录时 /login 直接返回 200 即说明服务活着
# 用 wget 的退出码判断：busybox wget 对 4xx/5xx 返回非零。
# 之前 `grep -q "200"` 会匹配到 Content-Length: 200x 之类的任意位置，
# 一个 500 响应也能被判成 healthy。
# 健康检查打的是容器内 127.0.0.1，必须绕开代理：
# busybox 的 wget 会读 http_proxy / HTTP_PROXY，一旦容器环境里配了代理（国内 NAS
# 很常见），这个请求会被发到代理；代理若不可达或不转发回环地址，wget 就一直等到
# 超时——容器被判 unhealthy，sync 日志里却什么错都没有。这正是群晖上的现象。
#   env -u ...：把这几个变量剥掉再执行（实测：留有代理时 exit=143 被杀，
#   剥掉后 exit=0 立即返回）
#
# timeout 也从 5s 放宽到 10s：写库虽是分块提交，冷启动与慢盘仍会有抖动。
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
      wget -q -O /dev/null "http://127.0.0.1:${PORT}/login" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "server.mjs"]
