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
COPY server.mjs ./server.mjs
COPY public ./public

# 数据目录：镜像内建好并交给 bun 用户写（挂载卷覆盖时仍可用）
RUN mkdir -p /data && chown -R bun:bun /app /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    DATA_DIR=/data

USER bun

EXPOSE 8788
VOLUME ["/data"]

# 健康检查：未登录时 /login 直接返回 200 即说明服务活着
# 用 wget 的退出码判断：busybox wget 对 4xx/5xx 返回非零。
# 之前 `grep -q "200"` 会匹配到 Content-Length: 200x 之类的任意位置，
# 一个 500 响应也能被判成 healthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/login" || exit 1

CMD ["bun", "server.mjs"]
