# AGENTS.md · 开源雷达

GitHub 收藏（star + fork）本地看板。上位约定见 `../AGENTS.md`。

## 技术约定

- **零第三方依赖**是硬约束。后端只用 Bun 内置（`Bun.serve`、`bun:sqlite`、`fetch`），前端手写，无构建步骤。加任何 npm 包前先问用户。
- 数据只落 `data/radar.db`（SQLite）。不要引入 Postgres/Redis/向量库。
- **token 只从环境变量读**（`GITHUB_TOKEN` / `GH_TOKEN`），永远不写进文件、日志、前端响应。
- 单文件后端：路由、GitHub 客户端、规则引擎都在 `server.mjs`。要拆时先说明理由。

## 关键实现约束

- `gh()` 是所有 GitHub 请求的唯一出口，负责 403/429 的分类与 `X-RateLimit-Reset` 等待重试。**不要在别处裸调 fetch 打 GitHub**（README 抓取除外，它需要 raw 响应）。
- **403 必须读 body 分类**：`Repository access blocked`（TOS 封禁）不是限流，按 900s×3 等下去会谎报「配额用尽」并卡死 15 分钟。现在非限流 403 返回 `{forbidden:true}` 由调用方跳过。
- 手工改过的简介 `digest_src='manual'`，同步时**不得覆盖**；`applyAutoTags()` 里已有保护，改逻辑时别退回去。
- 默认只监听 `127.0.0.1`。改 `HOST=0.0.0.0` 属于把个人数据暴露到局域网/公网，需用户明确授权。
- `/api/star` 会真实写 GitHub。未配 token 时必须返回明确错误，不允许静默成功。
- **前端受 CSP 约束，禁止内联样式与内联脚本**：`style-src 'self'` 会把 `style="…"` 属性、`<style>` 块整条丢弃且不报错（属性还在 DOM、CSSOM 为空），页面表现为「样式全丢、按钮无效」。样式写 `app.css`，脚本外链到 `public/*.js`。

## 实测坑（别重复踩）

- **`get_file_contents` 不是 JSON passthrough**：本机 MCP github 版本会走真 git 解析，`owner=user&repo=starred` 一律 404。想拿 starred 列表走 REST。
- **匿名 GitHub 只有 60 次/小时**：第一次全量同步必须带 token。
- **`Accept: application/vnd.github.star+json` 在没有 user scope 时会 401**，别以为接口挂了。
- **`[hidden]` 会被 `display:flex` 覆盖**：抽屉用 `hidden` 属性控制显隐，CSS 里必须补 `.drawer[hidden]{display:none!important}`。
- **标签规则的短词必须加边界**：裸子串会大面积误判，实测踩过的坑——`orm` 命中 platf**orm**、`rag` 命中 d**rag**on/sto**rag**e、`word\b` 命中 pass**word**、`sing` 命中 u**sing**、`ide\b` 命中 prov**ide**、`bt\b` 命中 d**bt**、`cd\b` 命中 sh.**cd**、`flux` 命中 **Flux**Down、`ocr` 命中 mo**creak**、`av\b` 命中 lib**av**、`hack` 命中 **hack**toberfest、`frida` 命中 **Fri**day、`ui\b` 命中 x-**ui**/3x-**ui**、`剪` 命中**剪**贴板、`deploy` 命中 mocreak 的「installs and **deploys**」。写规则时一律用 `\bxxx\b`，中文多字词（剪辑/剪映/免root）才可裸写。
- **`android` 单独出现不代表逆向**：tldr-pages、scrcpy、rustdesk 都只因「支持安卓」被误判成「安卓逆向」（曾 28 条）。现在要求 `android` 与 `逆向|magisk|xposed|frida|脱壳|hook|root` 同现，或直接命中 `magisk/xposed/frida/刷机/免root`。
- **`ui` 需要后视断言**：`\bui\b` 仍会把 `x-ui`、`3x-ui` 判成前端项目（`-` 是词边界）。写法 `(?<![a-z0-9-])ui\b(?![-.])`。Python 的 `re` 不支持变长后视，`import_mcp_cache.py` 里同一规则照抄这条没问题（固定宽度 1 字符）。
- **规则表有三份必须同步**：`server.mjs` 的 `RULES`（服务端权威）、`scripts/import_mcp_cache.py` 的 `TAGS`（离线导入）、`public/app.js` 的 `rulePreview` 里的 `R`（抽屉「用规则重算」按钮）。改一处必须改三处，否则前端预览与服务端结果不一致。
- **改规则后必须全库重算**：一次性脚本从 `server.mjs` 里 `new Function` 抽出 `RULES` + `ruleDigest`（抽取范围到 `/* ---- 入库 ---- */` 注释为止，**不能包含 `const fmt =`**，否则 `ReferenceError: fmt is not defined`），清 `repo_tags WHERE source='auto'` 后重写（manual 一律保留），再对 `digest_src` 为 null/rule 的行重写简介。
- **审计手段**：跑一遍全库，只打印「命中串长度 ≤ 4」的可疑项及上下文，人工过一遍。当前 228 条库残留 85 条短词命中，逐条确认后全是正常短词（`cli`、`vue`、`pdf`、`game`、`llm` 等真正相关的项目）。
- **`python3` 用 urllib 打 GitHub 会 SSL 证书失败**（本机 Python 3.10 缺 CA），改用 `~/.bun/bin/bun -e` 发请求。
- **滚动条必须主题化**：全局 `::-webkit-scrollbar` 细窄透明边 + `scrollbar-color`，配色走 `--sb-thumb` 变量；侧栏用 `scrollbar-gutter: stable` 防抖动。
- **README 相对锚点 `[#xxx]` 与 badge 语法**会原样裸露方括号，`miniMarkdown` 已补 `(#...)` 和 `[![](...)](...)` 两条替换。
- **bun:sqlite 命名参数必须带 `$` 前缀绑定**：`prepare("VALUES ($id,$full_name)")` 配 `run({id,full_name})` 会静默绑空 → `NOT NULL constraint failed`。键必须写成 `{$id:..., $full_name:...}`。
- **star+json 里 `repo` 可能为 `null`**（仓库已删/转私有/无权限），paged() 会跳过并 warn，绝不能把包装对象当 repo 写库。
- **未登录放行名单要按解解析后的文件名判断**：`/themes` 会 alias 到 `themes.html`，路径本身不以 `.html` 结尾，用正则匹配会被漏掉并 302。现用 `ASSET_FILES` 集合 + `PAGE_ALIAS` 解析。
- **浏览器自动化进程回收**：通用规矩已上移到全局规范「工程纪律 → 浏览器自动化进程必须回收」，此处不重复。现场经验：`agent-browser` 的 headless Chrome 不会自己退，反复调用会累积成几十个进程并吃满 fd（实测 37 个 → `ERR_INSUFFICIENT_RESOURCES`）；恢复顺序是清残留 → 重启 daemon（删 `~/.agent-browser/default.pid`）→ 换端口 → 改 curl 直连接口验证。
- **测试必须隔离数据库**：启动脚本支持 `RADAR_DB=/path/radar.db`（完整文件路径）+ `RADAR_GH`（mock API 基址）。没隔离会写进真库。
- **测试实例用完当场停**：测试端口与正式端口（8788）必须错开，`RADAR_DB` 指向的临时目录不得位于 `/tmp` 清理范围内（曾把测试实例的库删掉，前端 SSE 无限重连 → 渲染进程 101% CPU 35 分钟拖死整机）。规矩：① PID 记到 `/tmp/radar-test.pid`；② 验证结束立刻 kill；③ 清理 `/tmp` 前先 `pgrep -f server.mjs` 确认；④ 只保留一个对外实例。
- **前端 SSE 必须指数退避**：`EventSource.onerror` 里禁止写死固定间隔重连。当前实现 5s→10s→20s→40s 封顶 60s，重连前关闭旧连接。

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

验收判据：`/api/status` 的 `counts` 非零、卡片数 = `counts.starred + counts.fork`、抽屉能出 README、窄视口下 `document.documentElement.scrollWidth === clientWidth`（无横向溢出）。验证结束把 agent-browser 临时 Chrome 清到 0 个进程。
