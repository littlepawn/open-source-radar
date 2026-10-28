<p align="center">
  <img src="public/icon-192.png" width="104" height="104" alt="开源雷达" />
</p>

<h1 align="center">开源雷达</h1>

<p align="center">把 GitHub 的 Star 与 Fork 拉回本地，做成一页可搜、可筛、可分类的收藏看板</p>

<p align="center">
  <a href="https://hub.docker.com/r/littlepawn/open-source-radar"><img src="https://img.shields.io/docker/pulls/littlepawn/open-source-radar?logo=docker&logoColor=white" alt="Docker Pulls" /></a>
  <a href="https://hub.docker.com/r/littlepawn/open-source-radar"><img src="https://img.shields.io/docker/v/littlepawn/open-source-radar?sort=semver&logo=docker&logoColor=white" alt="Docker Image Version" /></a>
  <a href="https://github.com/littlepawn/open-source-radar/stargazers"><img src="https://img.shields.io/github/stars/littlepawn/open-source-radar?logo=github" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Runtime: Bun" />
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero dependencies" />
</p>

<p align="center">
  把 <b>starred</b> 和 <b>fork</b> 仓库拉到本地 SQLite，自动写中文简介和标签，用一个网页看板搜索、筛选、分类管理；另外带「发现热门开源项目」与「跟踪新版本」。
</p>

<p align="center">
  <sub>零第三方依赖 · 单文件服务端 · 数据只存你自己的 SQLite</sub>
</p>

---

**零第三方依赖**：只用 Bun 内置（`Bun.serve` + `bun:sqlite` + `fetch`），前端是手写 HTML/CSS/JS，没有构建步骤。

> 官方 REST 没有 GitHub Lists 端点（`GET /user/lists` 实测 404），所以分类全部存本地 SQLite，不回写 GitHub。

---

## 快速开始

```bash
# 带 token（推荐，5000 次/小时，能拉完全部页）
GITHUB_TOKEN=ghp_xxx ./start.sh

# 不带 token（匿名 60 次/小时，只能拿到最近一页，要告诉它读谁）
RADAR_LOGIN=你的用户名 ./start.sh
```

打开 <http://127.0.0.1:8788>，用 GitHub token 登录后点左下角「同步 GitHub」。

Token 只在环境变量里，不落盘、不打日志。建法：<https://github.com/settings/tokens>，classic token 勾 `public_repo` 就够（读取自己的 star 列表需要 `user` 权限，勾上更稳）。

匿名模式走 `/users/<login>/starred`（能读公开收藏），代价是 60 次/小时且只能拿到最近一页。限流时接口会直接回「触发限流，约 N 分钟后恢复」，不会静默卡住。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **同步** | `/user/starred` 分页拉 star（保留 `starred_at` 时间），`/users/:login/repos` 拉自己的 fork；再次同步是增量的，追平上次边界即停 |
| **自动同步** | 默认开启、每 2 小时拉一次，间隔在「设置」页改（下限 15 分钟）。服务重启后按「上次同步 + 间隔」重算，错过就立刻补 |
| **fork 上游** | 每个 fork 记录 `upstream`（`vaxilu/x-ui` 这类），卡片和详情都显示「fork 自 xxx」 |
| **中文简介** | 规则引擎按描述 + topics + 语言生成一句中文定位，原作者写了中文就优先显示原文 |
| **自动标签** | 31 条规则映射到业务域（AI / 大模型、容器 / 运维、网络代理、安卓逆向…），可手工增删 |
| **看板** | 卡片网格、关键词搜索、按标签 / 语言筛选、按 star / 更新时间 / 收藏时间排序、暗色明亮双主题 |
| **详情抽屉** | README 内联渲染、Topics、可改简介（改过的不再被规则覆盖）、可加自定义标签 |
| **隐藏** | 不想看的项目一键隐藏，不影响 GitHub 上的 star |
| **发现热门** | 走 GitHub Search API：总 star 榜 / 最近活跃 / 近 3 月-5 年新建，也能填原生搜索语法 |
| **新版本** | 对 star 数前 25 的项目查 `/releases/latest`，有新版就在卡片上显示版本号 |
| **备份** | 「导出备份」下载 JSON（标签 + 自定义简介 + 隐藏列表），不会被重新同步冲掉 |

---

## 数据在哪

```
data/radar.db         SQLite（repos / tags / repo_tags / releases / hidden / events / auth / sessions）
data/mcp-cache.json   批量导入用的中间文件（可选）
```

想清空重来就删 `data/radar.db*` 再启动。

---

## 登录鉴权

首次打开会进登录页，**必须填自己的 GitHub token**，不填进不去。

- 支持 `ghp_` / `gho_` / `ghu_` / `ghs_` 开头和 `github_pat_` 开头的 token
- 提交后除了格式校验，还会真调 `GET /user` 验证一次，无效 token 直接拒绝
- 验证通过后 token 用 **AES-256-GCM** 加密写入 SQLite（密钥派生自 `SESSION_SECRET`），进程内存里只留解密值
- 会话用 HttpOnly Cookie（30 天），登出即清
- token 只用于向 GitHub 发请求，不出现在日志、前端响应里

设了 `GITHUB_TOKEN` 环境变量时自动视为已登录（单用户自托管场景）。

---

## Docker 部署

```bash
# 方式一：直接拉镜像
docker run -d --name open-source-radar \
  -p 127.0.0.1:8788:8788 \
  -v radar-data:/data \
  -e TZ=Asia/Shanghai \
  littlepawn/open-source-radar:latest

# 方式二：compose（仓库里带了 docker-compose.yml）
docker compose up -d
```

打开 <http://localhost:8788>，用 GitHub token 登录。

**数据持久化**：全部在 `/data/radar.db`（含仓库数据、标签、加密后的 token），挂在命名卷 `radar-data` 上，容器重建不丢。

**环境变量**

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8788` | 容器内监听端口 |
| `HOST` | `0.0.0.0` | 容器里必须 0.0.0.0 才能从外部访问 |
| `DATA_DIR` | `/data` | 数据库目录 |
| `SESSION_SECRET` | 自动生成 | 会话与 token 加密密钥，建议自己设一个固定值 |
| `GITHUB_TOKEN` | 无 | 设了就免登录 |

**本地构建**

```bash
docker build -t open-source-radar:latest .
```

> 拉不动 `oven/bun` 基础镜像时（国内常见），加一个前缀参数走镜像源：
>
> ```bash
> docker build --build-arg REGISTRY=docker.m.daocloud.io/ -t open-source-radar:latest .
> ```

**已发布镜像**：[docker.io/littlepawn/open-source-radar](https://hub.docker.com/r/littlepawn/open-source-radar)，当前 `2.3.3` / `latest`（digest `sha256:fe1813b3`），基于 `oven/bun:1.2-alpine`，约 107MB，非 root（bun 用户）运行。

```bash
docker pull littlepawn/open-source-radar:2.3.3
```

> **接本机 AI 服务时注意**：容器里的 `127.0.0.1` 是容器自己，不是你的电脑。
>
> 宿主机上跑 Ollama / one-api / magpie 之类的 OpenAI 兼容网关时，Base URL 要填
>
> ```
> http://host.docker.internal:端口/v1
> ```
>
> Docker Desktop（macOS / Windows）原生支持这个域名；Linux 需给容器加
> `--add-host=host.docker.internal:host-gateway`。填成 `127.0.0.1` 时面板会直接提示怎么改。

> **AI 返回「只输出了思考过程」**：推理模型（deepseek-v4 / o 系列 / QwQ 等）先输出
> 思维链再给正文，`单次上限 tokens` 太小会把额度全花在思考上。调到 2000 以上即可。

---

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/status` | 统计、标签、语言分布、限速剩余、同步状态 |
| GET | `/api/repos?q=&source=&tag=&lang=&sort=` | 列表（source: all/starred/fork/hidden） |
| GET | `/api/repo/:id` | 单仓详情（含标签） |
| GET | `/api/repo/:id/readme` | README 原文（首次抓取后本地缓存） |
| POST | `/api/repo/update` | 改简介 `{id, digest}` |
| POST | `/api/repo/tag` | 加/删标签 `{repo_id, name 或 tag_id, action}` |
| POST | `/api/hide` | 隐藏/恢复 `{id, hidden}` |
| POST | `/api/sync` | 触发同步 `{kind: all\|starred\|fork}` |
| GET/POST | `/api/settings/autosync` | 自动同步开关与间隔；GET 另返回 `next_run_at`、`last_error` |
| GET | `/api/events` | SSE，同步进度推送 |
| GET | `/api/discover?sort=&days=&q=&page=` | 热门发现 |
| POST | `/api/releases/check` | 检查新版本 `{limit}` |
| GET | `/api/export` | 导出 JSON |
| GET/POST | `/api/auth/state` `/api/auth/login` `/api/auth/logout` | 登录态、登录、登出 |

---

## 已知边界（实测）

- **匿名只能抓最近一页**：GitHub 匿名 60 次/小时，全量 260+ 页扛不住。首次全量必须带 token。
- **`/user/*` 匿名一律 401**：无 token 时改走 `/users/<login>/starred`，必须设 `RADAR_LOGIN`。
- **搜索配额是另一条线**：未配 token 时 `/search/repositories` 只有 10 次/分钟。
- **README 只缓存首次**：抓过一次就写进库，仓库更新 README 后要手动清 `repos.readme` 才重抓。
- **简介是规则生成，不是 AI**：规则判断不了语义细节。真要语义改写需在 `RULES` 之外接一层 LLM，目前刻意没做（不想为这个功能引入 API key 依赖）。
- **被 TOS 封禁的仓库**：上游查询会返回 403 `Repository access blocked`，代码已分类识别并跳过，不会当成限流卡 15 分钟。
- **写回 GitHub 的 Star 需要 token**：未配 token 时明确报错，不会静默失败。

---

## 文件

```
server.mjs                   后端（路由 + GitHub 客户端 + SQLite + 鉴权）
lib/rules.mjs                中文简介规则引擎（唯一规则表）
lib/insight.mjs              停滞判定 / 清理候选 / fork 落后 / 相似度
lib/ai.mjs                   AI 对话：预算裁剪、消息拼装、服务商预设
lib/discover.mjs             发现页阈值收敛与查询串拼装
lib/schedule.mjs             自动同步时间计算（ISO 解析、错过即补、间隔收敛）
public/index.html            主看板结构
public/app.css               主题与布局（dark/light 各一套 CSS 变量）
public/app.js                前端逻辑（零依赖）
public/md.js                 README 渲染器（UMD，浏览器与测试共用）
public/ai.js                 设置页与单仓 AI 对话
public/login.html/js         登录页
public/themes.html/css/js    主题预览页
tests/*.test.mjs             纯逻辑单测（bun test）
scripts/import_mcp_cache.py  从 data/mcp-cache.json 批量入库（保留手工简介）
scripts/merge_mcp_page.py    分页抓取结果合并去重
scripts/gh-cache.mjs         本地 GitHub 缓存/ETag 代理（可选）
start.sh                     启动脚本
```

前端受 CSP 约束（`style-src 'self'` / `script-src 'self'`）：**不能写内联 `style="…"` 或内联 `<script>`**，会被整条丢弃且不报错。新增页面资源要同步加进 `server.mjs` 的 `ASSET_FILES`，否则未登录访问会被 302 回 `/login`。

---

## 许可证

MIT
