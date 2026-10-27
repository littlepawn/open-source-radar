# AGENTS.md · 开源雷达

GitHub 收藏（star + fork）本地看板。上位约定见 `../AGENTS.md`。

## 技术约定

- **零第三方依赖**是硬约束。后端只用 Bun 内置（`Bun.serve`、`bun:sqlite`、`fetch`），前端手写，无构建步骤。加任何 npm 包前先问用户。
- 数据只落 `data/radar.db`（SQLite）。不要引入 Postgres/Redis/向量库。
- **token 只从环境变量读**（`GITHUB_TOKEN` / `GH_TOKEN`），永远不写进文件、日志、前端响应。
- 单文件后端：路由、GitHub 客户端、规则引擎都在 `server.mjs`。要拆时先说明理由。

## 关键实现约束

- `gh()` 是所有 GitHub 请求的唯一出口，负责 403/429 的 `X-RateLimit-Reset` 等待重试。**不要在别处裸调 fetch 打 GitHub**（README 抓取除外，它需要 raw 响应）。
- 手工改过的简介 `digest_src='manual'`，同步时**不得覆盖**；`applyAutoTags()` 里已有保护，改逻辑时别退回去。
- 默认只监听 `127.0.0.1`。改 `HOST=0.0.0.0` 属于把个人数据暴露到局域网/公网，需用户明确授权。
- `/api/star` 会真实写 GitHub。未配 token 时必须返回明确错误，不允许静默成功。

## 实测坑（别重复踩）

- **`get_file_contents` 不是 JSON passthrough**：本机 MCP github 版本会走真 git 解析，`owner=user&repo=starred` 一律 404。想拿 starred 列表走 REST。
- **匿名 GitHub 只有 60 次/小时**：第一次全量同步必须带 token，否则只能拿到最近 150 条左右。
- **`Accept: application/vnd.github.star+json` 在没有 user scope 时会 401**，别以为接口挂了。
- **`[hidden]` 会被 `display:flex` 覆盖**：抽屉用 `hidden` 属性控制显隐，CSS 里必须补 `.drawer[hidden]{display:none!important}`。
- **标签规则要按具体度排序**：`log`、`test`、`reverse` 这类短词会大面积误判（superpowers→数据库、esphome→数据库）。收紧成 `alertmanager`、`\be2e\b`、`decompil` 之类。
- **`python3` 用 urllib 打 GitHub 会 SSL 证书失败**（本机 Python 3.10 缺 CA），改用 `~/.bun/bin/bun -e` 发请求。
- **滚动条必须主题化**：全局 `::-webkit-scrollbar` 细窄透明边 + `scrollbar-color`，配色走 `--sb-thumb` 变量；侧栏用 `scrollbar-gutter: stable` 防抖动。别让默认宽滚动条裸露。
- **README 相对锚点 `[#xxx]` 与 badge 语法**会原样裸露方括号，`miniMarkdown` 已补 `(#...)` 和 `[![](...)](...)` 两条替换。
- **bun:sqlite 命名参数必须带 `$` 前缀绑定**：`prepare("VALUES ($id,$full_name)")` 配 `run({id,full_name})` 会静默绑空 → `NOT NULL constraint failed`。键必须写成 `{$id:..., $full_name:...}`（`saveRepo` 已统一加前缀）。之前 150 条是 Python 写库，没暴露；第一次走 JS upsert 就炸。
- **star+json 里 `repo` 可能为 `null`**（仓库已删/转私有/无权限），paged() 会跳过并 warn，绝不能把包装对象当 repo 写库。
- **绝不 pkill 用户浏览器**：验证前端只用 `agent-browser` 自己启动的实例。清理时按 `--user-data-dir=.../agent-browser-chrome-` 精确匹配进程，禁止 `pkill -f "Google Chrome"` 这类宽匹配——会杀掉用户正在用的 Chrome 和所有标签页。截图报 `ERR_INSUFFICIENT_RESOURCES` 时优先级：① 只重启 agent-browser daemon（`pkill -f agent-browser` + 删 `~/.agent-browser/default.pid`）② 换端口重开 ③ 改用 curl/静态检查，**不动用户浏览器**。
  - **临时 Chrome 用完即收**：`agent-browser` 启动的 headless Chrome 不会自己退，反复调用会累积成几十个进程并吃满 fd（本轮实测 37 个 → `ERR_INSUFFICIENT_RESOURCES`）。规矩是：一轮截图验证结束后立刻 `agent-browser close`（没有该子命令就用下面这条精确清理），确认 `--user-data-dir=.../agent-browser-chrome-` 的进程数为 0 再进入下一步；不要留到下次验证时再叠。
    ```bash
    # 只杀 agent-browser 自己的实例，不碰用户 Chrome
    ps -eo pid,command | grep "agent-browser-chrome-" | grep -v grep | awk '{print $1}' | xargs -r kill
    ```
  - **当轮验证结束顺手扫一遍**：`ps -eo command | grep -c "agent-browser-chrome-"`，非 0 就清。
- **测试必须隔离数据库**：启动脚本支持 `RADAR_DB=/path/radar.db`（完整文件路径）+ `RADAR_GH`（mock API 基址）。没隔离会写进真库（本轮实测污染过，已清理并验证 150 行恢复）。
- **测试实例用完当场停，并记住它占的端口**：测试端口与正式端口（8788）必须错开，`RADAR_DB` 指向的临时目录**不得位于 `/tmp` 清理范围内**（本轮事故：清理 `/tmp` 删掉了 8890 测试实例的库，实例带病运行，前端 SSE 无限 5s 重连 → 渲染进程 101% CPU 35 分钟拖死整机）。规矩：① 测试实例启动时把 PID 记到 `/tmp/radar-test.pid`；② 验证结束立刻 `kill $(cat /tmp/radar-test.pid)`；③ 清理 `/tmp` 前先 `pgrep -f server.mjs` 确认没有实例引用该路径；④ 只保留一个对外实例。
- **前端 SSE 必须指数退避**：`EventSource.onerror` 里禁止写死固定间隔重连，否则服务端持续失败时渲染进程会陷入重连风暴。当前实现为 5s→10s→20s→40s 封顶 60s，重连前关闭旧连接。

## 验证方式

```bash
# 后端
curl -s localhost:8788/api/status | head -c 300
curl -s "localhost:8788/api/repos?sort=pushed&limit=3"

# 前端（需要 escalated 权限，agent-browser 要写 ~/.agent-browser）
agent-browser open http://127.0.0.1:8788
agent-browser set viewport 420 900     # 移动端回归
agent-browser screenshot /tmp/x.png
```

验收判据：`/api/status` 的 `counts` 非零、卡片数 = `counts.starred + counts.fork`、
抽屉能出 README、窄视口下 `document.documentElement.scrollWidth === clientWidth`（无横向溢出）。
