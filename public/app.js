/* 开源雷达 前端：零依赖 */
const $ = (s) => document.querySelector(s);
const api = async (p, opt) => {
  const r = await fetch(p, opt);
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  if (r.status === 401 && d && d.needs_login) {
    location.href = "/login";
    throw new Error("未登录");
  }
  if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
  return d;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 只放行 http(s)：仓库的 homepage / README 里的链接都来自外部，
// javascript: 与 data: 会变成可点击的 XSS。白名单之外一律返回空串（不渲染链接）。
const safeUrl = (u) => {
  const s = String(u ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
};
// topics 在库里是字面量字符串，损坏或非数组时 JSON.parse 会抛错，
// 一抛就把整块面板/整个版本列表打空。统一走这个安全解析。
const parseTopics = (v) => {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};
const fmt = (n) => {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(n);
};
const ago = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso.slice(0, 10);
  const s = (Date.now() - d) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前";
  if (s < 86400 * 30) return Math.round(s / 86400) + " 天前";
  if (s < 86400 * 365) return Math.round(s / 86400 / 30) + " 个月前";
  return Math.round(s / 86400 / 365) + " 年前";
};

const state = {
  scope: "all",
  view: "repos",
  q: "",
  tag: "",
  lang: "",
  sort: "stars",
  items: [],
  tags: [],
  status: null,
};

/* ---------------- 侧栏渲染 */
function renderSide() {
  const st = state.status || {};
  $("#whoami").textContent = st.login ? `@${st.login} · ${st.token || ""}` : "本地 · 未同步";
  $("#nAll").textContent = (st.counts?.starred || 0) + (st.counts?.fork || 0);
  $("#nStar").textContent = st.counts?.starred || 0;
  $("#nFork").textContent = st.counts?.fork || 0;
  $("#nHide").textContent = st.counts?.hidden || 0;
  $("#nDisc").textContent = st.counts?.discover || 0;
  $("#nDisc").textContent = st.counts?.discover || 0;
  const tags = st.tags || [];
  state.tags = tags;
  $("#tagCount").textContent = tags.length ? `${tags.length}` : "";
  const maxN = Math.max(1, ...tags.map((t) => t.n));
  $("#tagList").innerHTML = tags
    .filter((t) => t.n > 0)
    .map(
      (t) => `<button class="chip ${state.tag === t.name ? "active" : ""}" data-tag="${esc(t.name)}"
        ${t.color ? `data-color="${esc(t.color)}"` : ""}>${esc(t.name)}<b>${t.n}</b></button>`
    )
    .join("") || `<span class="minihint">同步后自动归类</span>`;
  $("#langList").innerHTML = (st.langs || [])
    .slice(0, 14)
    .map((l) => `<button class="chip ${state.lang === l.language ? "active" : ""}" data-lang="${esc(l.language)}">${esc(l.language)}<b>${l.n}</b></button>`)
    .join("");
  const sync = st.sync || {};
  $("#syncBtn").disabled = !!sync.running;
  if (sync.running && sync.retry_at) {
    const left = Math.max(0, Math.round((sync.retry_at - Date.now()) / 1000));
    $("#syncHint").textContent = `配额用尽，${left}s 后重试`;
  } else $("#syncHint").textContent = sync.running
    ? `${sync.phase || "同步中"} ${sync.done}/${sync.total || "?"}`
    : st.stars_synced_at
      ? `上次同步 ${ago(st.stars_synced_at)}`
      : "还没同步过";
}

/* ---------------- 卡片 */
function cardHTML(r, ctx = "repo") {
  const tags = r.tags || r.tag_names?.split("|") || [];
  const digest = r.digest || "";
  const [head, tail] = digest.split("\n");
  const hidden = r.hidden ? " · 已隐藏" : "";
  return `<article class="card" data-id="${r.id}" data-ctx="${ctx}">
    <div class="name">
      <a href="${esc(r.html_url)}" target="_blank" rel="noreferrer" title="${esc(r.full_name)}" data-stop>${esc(r.name || r.full_name.split("/")[1])}</a>
      <span class="owner">${esc(r.owner || r.full_name.split("/")[0])}</span>
      ${r.source === "fork" || r.fork ? '<span class="badge fork">fork</span>' : ""}
      ${r.archived || r.arch ? '<span class="badge arch">归档</span>' : ""}
      ${r.language ? `<span class="badge">${esc(r.language)}</span>` : ""}
      ${hidden ? '<span class="badge arch">隐藏</span>' : ""}
    </div>
    ${head ? `<div class="digest">${esc(head)}${tail ? `<span class="stat">${esc(tail)}</span>` : ""}</div>`
           : `<div class="desc">${esc(r.description || "（无描述）")}</div>`}
    ${tags.length ? `<div class="rowtags">${tags.map((t) => `<button class="chip" data-tag="${esc(t)}" data-stop>${esc(t)}</button>`).join("")}</div>` : ""}
    <div class="foot">
      <span>★ ${fmt(r.stars)}</span>
      <span class="lang">${esc(r.language || "—")}</span>
      ${r.upstream ? `<span class="up">fork 自 ${esc(r.upstream)}</span>` : ""}
      <span>${ctx === "discover" ? "建于" : r.source === "fork" ? "fork 于" : "star 于"} ${ago(ctx === "discover" ? r.created_at : (r.starred_at || r.pushed_at))}</span>
      ${r.latest_tag ? `<span class="sp">${esc(r.latest_tag)} · ${ago(r.latest_release_at)}</span>` : '<span class="sp"></span>'}
      <button class="act" data-act="open" title="详情">详情</button>
    </div>
  </article>`;
}

/* ---------------- 列表 */
async function loadRepos() {
  const q = new URLSearchParams({ q: state.q, source: state.scope, tag: state.tag, lang: state.lang, sort: state.sort });
  if (state.scope === "hidden") q.set("source", "hidden");
  if (state.scope === "discover") q.set("source", "discover");
  const d = await api("/api/repos?" + q.toString());
  state.items = d.items || [];
  $("#cards").innerHTML = state.items.map((r) => cardHTML(r)).join("");
  $("#empty").hidden = state.items.length > 0;
  const bits = [`<b>${state.items.length}</b> 个仓库`];
  if (state.tag) bits.push(`标签 <b>${esc(state.tag)}</b>`);
  if (state.lang) bits.push(`语言 <b>${esc(state.lang)}</b>`);
  if (state.q) bits.push(`关键词 <b>${esc(state.q)}</b>`);
  if (state.status?.releases_checked_at) bits.push(`版本检查 ${ago(state.status.releases_checked_at)}`);
  $("#crumb").innerHTML = bits.join(" · ");
}

/* ---------------- 抽屉 */
let drawerSeq = 0;
async function openRepo(id) {
  let r;
  try {
    r = await api(`/api/repo/${id}`);
  } catch (e) {
    // 抽屉打开失败（仓库被删/转私有/网络错误）之前是静默 promise rejection，用户点了没反应
    toast("打不开该仓库：" + e.message);
    return;
  }
  const tags = (r.tags || []).map((t) => t.name);
  const allTags = state.tags.map((t) => t.name);
  const topics = parseTopics(r.topics);
  $("#drawerContent").innerHTML = `
    <h2><a href="${esc(r.html_url)}" target="_blank" rel="noreferrer">${esc(r.full_name)}</a></h2>
    <div class="meta">⭐ ${fmt(r.stars)} · ⑂ ${fmt(r.forks)} · ${esc(r.language || "—")} · ${esc(r.license || "无协议")}
      · 最后推送 ${ago(r.pushed_at)}${r.archived ? " · 已归档" : ""}${r.upstream ? ` · fork 自 <a href="https://github.com/${esc(r.upstream)}" target="_blank" rel="noreferrer">${esc(r.upstream)}</a>` : ""}${safeUrl(r.homepage) ? ` · <a href="${esc(safeUrl(r.homepage))}" target="_blank" rel="noreferrer">主页</a>` : ""}</div>
    <div class="sec">
      <label>我的中文简介（保存后不会被自动规则覆盖）</label>
      <textarea id="digEdit">${esc(r.digest || "")}</textarea>
      <div class="btnrow">
        <button class="primary" id="digSave">保存简介</button>
        <button class="ghost" id="digRule">用规则重算</button>
      </div>
    </div>
    <div class="sec">
      <label>标签（点选切换，输入新标签回车创建）</label>
      <div class="rowtags" id="tagEditor">
        ${[...new Set([...tags, ...allTags])].map((t) => `<button class="chip ${tags.includes(t) ? "active" : ""}" data-id2="${r.id}" data-tag2="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>
      <input id="newTag" placeholder="新标签，回车创建" autocomplete="off" />
    </div>
    <div class="sec">
      <label>Topics</label>
      <div class="rowtags">${topics.map((t) => `<span class="chip">${esc(t)}</span>`).join("") || '<span class="minihint">无</span>'}</div>
    </div>
    <div class="sec">
      <label>README</label>
      <div class="readme" id="readmeBox">加载中…</div>
    </div>
    <div class="sec btnrow">
      <button class="ghost" id="hideBtn">${r.hidden ? "恢复显示" : "隐藏该项目"}</button>
      <button class="ghost" id="starBtn">${r.source === "fork" ? "打开 Fork 源" : "去 GitHub 取消/加 Star"}</button>
    </div>`;
  const mySeq = ++drawerSeq;
  $("#drawer").hidden = false;

  $("#digSave").onclick = async () => {
    await api("/api/repo/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: r.id, digest: $("#digEdit").value }),
    });
    toast("简介已保存");
    await refresh();
  };
  $("#digRule").onclick = async () => {
    const guess = rulePreview(r, topics);
    $("#digEdit").value = guess;
  };
  $("#tagEditor").onclick = async (e) => {
    const b = e.target.closest("[data-tag2]");
    if (!b) return;
    const name = b.dataset.tag2;
    const on = b.classList.contains("active");
    await api("/api/repo/tag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_id: r.id, name, action: on ? "remove" : "add" }),
    });
    b.classList.toggle("active");
    await refresh(false);
  };
  $("#newTag").onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    const name = e.target.value.trim();
    if (!name) return;
    await api("/api/repo/tag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_id: r.id, name, action: "add" }),
    });
    openRepo(r.id);
    refresh(false);
  };
  $("#hideBtn").onclick = async () => {
    await api("/api/hide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: r.id, hidden: !r.hidden }),
    });
    $("#drawer").hidden = true;
    toast(r.hidden ? "已恢复显示" : "已隐藏");
    refresh();
  };
  $("#starBtn").onclick = () => window.open(r.html_url, "_blank", "noreferrer");

  // README
  try {
    const md = await api(`/api/repo/${id}/readme`);
    // 期间用户可能已切到别的仓库或关掉抽屉，迟到的响应不能覆盖当前面板
    if (mySeq !== drawerSeq || $("#drawer").hidden) return;
    $("#readmeBox").innerHTML = md.markdown ? miniMarkdown(md.markdown, r.full_name) : "（该仓库没有 README，或已超出 200KB 截断）";
  } catch (e) {
    if (mySeq !== drawerSeq || $("#drawer").hidden) return;
    $("#readmeBox").textContent = "README 读取失败：" + e.message;
  }
}

function rulePreview(r, topics) {
  const hay = `${r.description || ""} ${topics.join(" ")} ${r.name || ""} ${r.language || ""}`.toLowerCase();
  const R = [
    [/ppt|slide|presentation|keynote|powerpoint/, "做 PPT / 演示文稿"],
    [/excel|spreadsheet|xlsx|office|docx|\bword\b/, "文档表格处理"],
    [/agent|langgraph|autogen/, "AI Agent 框架"],
    [/llm|gpt|claude|qwen|deepseek|inference|vllm|ollama/, "大模型推理与服务"],
    [/\brag\b|ragflow|embedding|vector|milvus|chroma|faiss/, "向量检索 / RAG"],
    [/diffusion|comfyui|\bflux\b|sdxl|image-gen/, "AI 文生图"],
    [/tts|voice|speech|whisper|asr|audio|music|\bsing/, "语音合成与识别"],
    [/video|ffmpeg|subtitle|remotion/, "视频处理"],
    [/docker|kubernetes|k8s|helm|compose/, "容器与编排"],
    [/proxy|tunnel|frp|wireguard|vpn|clash|sing-box|v2ray|xray|nginx/, "网络代理 / 反代"],
    [/monitor|prometheus|grafana|uptime|alert/, "监控告警"],
    [/\bnas\b|home-assistant|homelab|self-host|dashboard/, "自托管 / 家庭服务器"],
    [/scrap|crawl|spider|puppeteer|playwright|selenium/, "抓取与浏览器自动化"],
    [/chrome|extension|userscript|tampermonkey/, "浏览器扩展"],
    [/macos|swiftui|\bios\b|iphone|uikit|app store/, "Apple 平台应用"],
    [/\bmagisk\b|\bxposed\b|\bfrida\b|刷机|免root|\badb\b|android.*(逆向|破解|改机|去广告|root)/, "安卓改造与逆向"],
    [/reverse|decompil|ghidra|\bida\b|exploit|\bpwn\b|malware/, "逆向 / 安全研究"],
    [/crypto|bitcoin|ethereum|blockchain|web3|wallet/, "区块链"],
    [/sql|database|postgres|mysql|sqlite|redis|mongo|\borm\b/, "数据库"],
    [/terminal|shell|\bcli\b|\btui\b/, "命令行 / TUI"],
    [/editor|vim|neovim|emacs|\bide\b|code[- ]?editor/, "编辑器 / IDE"],
    [/(?<![a-z0-9-])ui\b(?![-.])|component|tailwind|\breact\b|\bvue\b|svelte|frontend|\bcss\b/, "前端 UI / 组件"],
    [/\be2e\b|cypress|jest|vitest|test-framework/, "测试工程"],
    [/\bci\b|continuous (delivery|integration)|pipeline|github action|devops|ci\/cd/, "CI/CD"],
    [/security|vulnerab|\bcve\b|pentest|\bhack(ing|er)?\b|hackthebox|渗透|漏洞/, "安全攻防"],
    [/game|emulator|retro|steam/, "游戏"],
    [/download|magnet|torrent|onedrive|aliyun/, "下载 / 网盘"],
    [/translat|i18n/, "翻译"],
    [/\bpdf\b|\bocr\b|\bscan(n(ing|er))?\b|文字识别|识别文字/, "OCR 识别"],
  ];
  const hits = R.filter(([re]) => re.test(hay)).map((x) => x[1]).slice(0, 2);
  const d = (r.description || "").slice(0, 110);
  const head = hits.length ? `${hits.join("；")}。${d}` : d || "暂无描述。";
  return `${head}\n${r.language || "未知语言"} · ⭐ ${fmt(r.stars)} · 最后推送 ${(r.pushed_at || "").slice(0, 10)}`;
}

/* 极简 markdown 渲染器。
   旧实现先把整篇文档 HTML 转义、再试图替换 <img>，转义已经把 < 变成 &lt;，
   于是 README 里的 HTML（<div align="center">、<p>、<a href>、<strong>）
   全部原样显示成文本——GitHub 上的 README 几乎都带 HTML，等于全废。
   现在改为：钉住 fenced code → 保护行内 code → 逐行块级解析（标题/列表/引用/表格/HTML 块）
   → 行内解析（图片/链接/加粗/斜体/删除线）→ 白名单放行安全的 HTML 标签。 */

// README 来自外部仓库，放行的 HTML 标签与属性都做白名单，
// 事件处理器、style、iframe/script 一律丢弃。
const MD_VOID = new Set(["img", "br", "hr", "input", "wbr", "col"]);
const MD_BLOCK = new Set([
  "div", "p", "center", "details", "summary", "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
  "a", "b", "i", "strong", "em", "del", "s", "u", "sub", "sup", "small", "br", "hr",
  "img", "picture", "source", "figure", "figcaption", "kbd", "mark", "span", "section", "article",
  "video", "audio", "track", "abbr", "time", "nav", "header", "footer", "main",
]);
const MD_ATTR = {
  a: ["href", "title"],
  img: ["src", "srcset", "alt", "title", "width", "height"],
  // <picture> 的暗色模式徽章普遍写成 <source srcset=…>，不放行 srcset 会退化成
  // 一串裸露的 &lt;source …&gt; 文本（mise / llama.cpp 这类 README 都会中招）。
  source: ["srcset", "media", "type", "sizes", "width", "height"],
  video: ["src", "poster", "width", "height", "controls", "loop", "muted", "playsinline"],
  audio: ["src", "controls", "loop"],
  td: ["colspan", "rowspan"], th: ["colspan", "rowspan"],
  div: ["align"], p: ["align"], h1: ["align"], h2: ["align"], h3: ["align"],
  center: ["align"], table: ["align"], span: ["title"],
};
// 标签内属性：只留白名单，href/src 再过 safeUrl
function mdAttrs(tag, raw, base) {
  const allow = MD_ATTR[tag] || [];
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (!allow.includes(name)) continue;                 // 事件处理器/ style / class 都在这里被丢
    let val = m[3] ?? m[4] ?? m[5] ?? "";
    if (name === "href") {
      // 只放行真能跳转的：绝对 http(s) 与页内锚点。
      // ./README.zh_CN.md 这类相对链接指向仓库里的另一个文件，本地看板没有它，
      // 留着 href 点下去只会得到 404 页面，不如当普通文字。
      if (!/^https?:\/\//i.test(val) && !val.startsWith("#")) continue;
    }
    if (name === "src") {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(val) && !/^https?:\/\//i.test(val) && !/^data:image\//i.test(val)) continue;
      if (/^https?:\/\//i.test(val) || /^data:image\//i.test(val)) { /* 原样放行 */ }
      else if (base) {
        // 仓库相对图片（./docs/a.png、/web/logo.png）：改写成 CDN 地址。
        // 实测本机到 raw.githubusercontent.com / media.githubusercontent.com 抖动极大
        // （15s 超时约 2/3 失败），jsdelivr 的 gh 通道同样走 @HEAD 指向默认分支，
        // 实测 0.5-2s 稳定返回。
        val = `https://cdn.jsdelivr.net/gh/${base}@HEAD/${val.replace(/^\.?\//, "")}`;
      } else {
        continue; // 没有 base 就丢弃，避免破图标
      }
    }
    if (name === "srcset") {
      // srcset 是「url 描述符, url 描述符」，逐个 URL 单独改写相对路径
      const fixed = String(val).split(",").map((part) => {
        const seg = part.trim();
        if (!seg) return "";
        const [u, ...desc] = seg.split(/\s+/);
        let nu = u;
        // 带 scheme（javascript:/vbscript:/file: …）但不是 http(s)/data:image 的，直接丢
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) && !/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) return "";
        if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) {
          if (!base) return "";
          nu = `https://cdn.jsdelivr.net/gh/${base}@HEAD/${u.replace(/^\.?\//, "")}`;
        }
        return [nu, ...desc].join(" ");
      }).filter(Boolean);
      // 一个 URL 都不剩就整条丢掉，避免出现空的 srcset=""
      if (!fixed.length) continue;
      out.push(`${name}="${esc(fixed.join(", "))}"`);
      continue;
    }
    out.push(`${name}="${esc(val)}"`);
  }
  return out.length ? " " + out.join(" ") : "";
}

function miniMarkdown(md, base) {
  // base = "owner/repo"（来自仓库 html_url），相对图片会拼成 raw 地址；不传则丢相对图
  let src = String(md || "").slice(0, 200000);
  const stash = [];
  const save = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  // 1) fenced code 先钉住，避免内部被当成 markdown
  src = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, _lang, code) =>
    save(`<pre><code>${esc(code.replace(/\s+$/, ""))}</code></pre>`)
  );
  // 2) 行内 code 也钉住
  src = src.replace(/`([^`\n]+)`/g, (_, c) => save(`<code>${esc(c)}</code>`));

  // 2.5) HTML 注释整段丢掉。徽章区常写成 `</a><!--\n  --><a ...>` 用来消除行内空隙，
  //      不剔除就会被转义成 &lt;!-- 显示在页面上。放在 code 占位之后，代码块里的
  //      <!-- 示例不会被误删。
  src = src.replace(/<!--[\s\S]*?-->/g, "");

  // 3) 行内解析：白名单 HTML 先标记，避免被下面当普通文本转义两次
  const inline = (text) => {
    const held = [];
    const hold = (html) => `\u0001${held.push(html) - 1}\u0001`;
    let t = text;
    // 放行/清洗 HTML 标签
    t = t.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (full, nameRaw, attrs) => {
      const tag = nameRaw.toLowerCase();
      if (!MD_BLOCK.has(tag)) return esc(full);
      const close = full.startsWith("</");
      if (close) return MD_VOID.has(tag) ? "" : hold(`</${tag}>`);
      const selfClose = full.endsWith("/>") || MD_VOID.has(tag);
      const a = mdAttrs(tag, attrs || "", base);
      // 相对链接的 href 已被 mdAttrs 丢掉，此时 <a> 没有跳转能力，
      // 再挂 target/rel 只是噪音（空 href 的锚点在浏览器里等同纯文本）
      const linkExtras = tag === "a" && /\shref="/.test(a) ? ' target="_blank" rel="noreferrer"' : "";
      const loading = tag === "img" ? ' loading="lazy"' : "";
      // 相对路径的图片在本地没有 base，src 被 mdAttrs 丢掉后 <img> 只剩一个破图标。
      // 但响应式图片可以只有 srcset（合法写法），两者都空才丢。
      if (tag === "img" && !/\ssrc=/.test(a) && !/\ssrcset=/.test(a)) return "";
      return hold(`<${tag}${a}${loading}${linkExtras}${selfClose ? (MD_VOID.has(tag) ? ">" : " />") : ">"}`);
    });
    // 其余内容一律转义；已在上一步转义过的 & 不再二次转义
    t = t.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // 图片（相对路径在本地看板不可用，丢弃）
    // URL 里允许一层括号，否则 alert(1) 这类内容会把 ) 留在外面
    const URL_RE = "([^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*)";
    t = t.replace(new RegExp("!\\[([^\\]]*)\\]\\(\\s*" + URL_RE + "[^)]*\\)", "g"), (_, alt, src2) => {
      if (!/^https?:\/\//i.test(src2) && !/^data:image\//i.test(src2)) {
        if (!base) return "";
        src2 = `https://cdn.jsdelivr.net/gh/${base}@HEAD/${src2.replace(/^\.?\//, "")}`;
      }
      return `<img src="${esc(src2)}" alt="${alt}" loading="lazy">`;
    });
    // 链接：http(s) 与锚点，其余只留文字
    t = t.replace(new RegExp("\\[([^\\]]+)\\]\\(\\s*" + URL_RE + "[^)]*\\)", "g"), (_, label, href) => {
      if (/^https?:\/\//i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noreferrer">${label}</a>`;
      if (href.startsWith("#")) return `<a class="mdlink" href="${esc(href)}">${label}</a>`;
      return label;
    });
    t = t.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    t = t.replace(/ {2,}$/gm, "<br>");
    return t.replace(/\u0001(\d+)\u0001/g, (_, i) => held[Number(i)]);
  };

  // 4) 逐行块级解析
  const lines = src.split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let inHtmlBlock = 0;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // 钉住的整块内容直接输出
    if (/^\u0000\d+\u0000$/.test(t)) { closeList(); out.push(t); continue; }

    // HTML 块：<div ...> / </div> 这类独占一行且成对出现的容器
    // 自闭合写法 <div …/> 不增加块级深度，否则这类标签之后的整篇
    // 都会滞留在 html 块里（最终 </body> 失配 → 全部当容器内文本）
    const htmlOpen = t.match(/^<([a-zA-Z][\w-]*)(\s[^>]*)?(\/?)>$/);
    if (htmlOpen && !MD_VOID.has(htmlOpen[1].toLowerCase()) && !htmlOpen[3]) { inHtmlBlock++; }
    if (inHtmlBlock > 0) {
      // GitHub 在 <div align="center"> 里照常渲染 markdown（README 的 # 标题、
      // 列表都写在容器里），所以块内仍要认标题和列表，纯文本行走行内。
      const hh = t.match(/^(#{1,6})\s+(.*)$/);
      if (hh) {
        out.push(`<h${hh[1].length}>${inline(hh[2])}</h${hh[1].length}>`);
      } else if (/^[-*+]\s+/.test(t)) {
        if (list !== "ul") { if (list) out.push(`</${list}>`); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(t.replace(/^[-*+]\s+/, ""))}</li>`);
      } else {
        if (list) { out.push(`</${list}>`); list = null; }
        out.push(inline(line));
      }
      if (/^<\/[a-zA-Z][\w-]*>$/.test(t)) inHtmlBlock--;
      if (inHtmlBlock === 0) { if (list) { out.push(`</${list}>`); list = null; } out.push("\u0002"); }
      continue;
    }

    if (!t) { closeList(); continue; }
    if (/^<!--/.test(t) || /^-->$/.test(t)) { closeList(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeList(); out.push("<hr>"); continue; }

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    const bq = t.match(/^>\s?(.*)$/);
    if (bq) { closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

    const ul = t.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    // 表格：连续的 | a | b | 行
    if (/^\|.*\|$/.test(t)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(lines[i].trim()); i++; }
      i--;
      if (rows.length >= 2 && /^\|[\s:|-]+\|$/.test(rows[1])) {
        const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(2).map(cells);
        out.push(
          "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          body.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>"
        );
      } else {
        out.push(`<p>${rows.map((r) => inline(r)).join("<br>")}</p>`);
      }
      continue;
    }

    // 一行里既有块级容器标签又有正文时（`<table>…</table>` 后跟说明、
    // `<picture>…</picture> <picture>…</picture>` 之类），包 <p> 会产生
    // <p><table> 这种非法嵌套，浏览器会把 <p> 提前闭合，视觉上多出空行。
    // 以块级标签开头且整行内部标签都成对的，直接顶格输出。
    const startsWithBlock = /^<(?:div|p|center|details|summary|table|thead|tbody|tr|td|th|h[1-6]|ul|ol|li|blockquote|pre|picture|figure|section|article)\b/i.test(t);
    if (startsWithBlock) {
      const inner = inline(t);
      const opens = (inner.match(/<(?!\/)([a-zA-Z][\w-]*)/g) || []).length;
      const closes = (inner.match(/<\/([a-zA-Z][\w-]*)>/g) || []).length +
                     (inner.match(/<(?:img|br|hr|input|wbr|col)\b[^>]*>/g) || []).length;
      if (opens > 0 && opens === closes) { out.push(inner); continue; }
    }

    closeList();
    out.push(`<p>${inline(t)}</p>`);
  }
  closeList();

  let html = out.join("\n");
  // href 被丢掉的 <a> 没有跳转能力，剥成纯内容（<a href=...> 不受影响）
  html = html.replace(/<a>([\s\S]*?)<\/a>/g, "$1");
  // 钉住的内容回填
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)] ?? "");
  // 行内保留位回填（inline 内部已处理，这里兜一次跨行的）
  html = html.replace(/\u0001(\d+)\u0001/g, "");
  return html;
}

/* ---------------- 发现热门 */
async function loadDiscover() {
  const q = new URLSearchParams({
    sort: $("#dSort").value,
    days: $("#dDays").value,
    q: $("#dQ").value.trim(),
  });
  $("#dResult").innerHTML = `<div class="empty">搜索中…</div>`;
  try {
    const d = await api("/api/discover?" + q);
    if (!d.items?.length) {
      $("#dResult").innerHTML = `<div class="empty">没结果。可能触发了 GitHub 搜索配额（未配 token 时 10 次/分钟），等一分钟再试。</div>`;
      return;
    }
    $("#dResult").innerHTML =
      `<div class="crumb spanall">查询条件 <b>${esc(d.query)}</b> · 命中 <b>${fmt(d.total)}</b> 个仓库${d.rate?.remaining != null ? ` · 搜索配额剩余 ${d.rate.remaining}` : ""}</div>` +
      d.items.map((r) => cardHTML({ ...r, source: "starred" }, "discover")).join("");
  } catch (e) {
    $("#dResult").innerHTML = `<div class="empty">失败：${esc(e.message)}</div>`;
  }
}

/* ---------------- 新版本 */
async function loadReleases(check) {
  if (check) {
    $("#relGo").disabled = true;
    $("#relHint").textContent = "检查中（每个项目一次 API 调用）…";
    try {
      const r = await api("/api/releases/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 25 }),
      });
      $("#relHint").textContent = `检查 ${r.checked} 个，发现 ${r.changed} 个新版本`;
    } catch (e) {
      $("#relHint").textContent = "失败：" + e.message;
    }
    $("#relGo").disabled = false;
  }
  const list = await api("/api/releases");
  $("#relList").innerHTML = list.length
    ? list.map((r) => {
        const topics = parseTopics(r.topics);
        return `<article class="card" data-id="${r.id}" data-ctx="repo">
          <div class="name"><a href="${esc(r.html_url)}" target="_blank" rel="noreferrer" data-stop>${esc(r.full_name)}</a>
            <span class="badge">${esc(r.tag || "")}</span></div>
          <div class="desc">${esc(r.name || "")}</div>
          <div class="digest">发布于 ${ago(r.published_at)}<span class="stat">★ ${fmt(r.stars)}</span></div>
          <div class="foot"><a href="${esc(r.url)}" target="_blank" rel="noreferrer" class="link">打开 Release</a><span class="sp"></span>
          <button class="act" data-act="open">详情</button></div>
        </article>`;
      }).join("")
    : `<div class="empty">还没有记录。点上面的按钮检查一次。</div>`;
}

/* ---------------- 通用 */
let toastTimer;
function toast(msg, err) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function refresh(reloadList = true) {
  state.status = await api("/api/status");
  renderSide();
  if (reloadList && state.view === "repos") await loadRepos();
}

/* 事件绑定 */
document.addEventListener("click", async (e) => {
  const navScope = e.target.closest("[data-scope]");
  const navView = e.target.closest("[data-view]");
  const tagBtn = e.target.closest("[data-tag]");
  const langBtn = e.target.closest("[data-lang]");
  const card = e.target.closest(".card");
  const openBtn = e.target.closest("[data-act='open']");

  if (tagBtn) {
    if (e.target.closest("[data-stop]") && !e.target.closest("#tagList")) {
      // 卡片上的标签点击也切换筛选
    }
    state.tag = state.tag === tagBtn.dataset.tag ? "" : tagBtn.dataset.tag;
    state.view = "repos";
    showView("repos");
    await refresh();
    return;
  }
  if (langBtn) {
    state.lang = state.lang === langBtn.dataset.lang ? "" : langBtn.dataset.lang;
    state.view = "repos";
    showView("repos");
    await refresh();
    return;
  }
  if (navScope) {
    state.scope = navScope.dataset.scope;
    state.tag = "";
    state.view = "repos";
    showView("repos");
    document.querySelectorAll("[data-scope]").forEach((b) => b.classList.toggle("active", b === navScope));
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("active"));
    await refresh();
    return;
  }
  if (navView) {
    state.view = navView.dataset.view;
    showView(state.view);
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("active", b === navView));
    document.querySelectorAll("[data-scope]").forEach((b) => b.classList.remove("active"));
    if (state.view === "discover") await loadDiscover();
    if (state.view === "releases") await loadReleases(false);
    return;
  }
  if (openBtn) {
    const id = openBtn.closest(".card")?.dataset.id;
    if (id) openRepo(Number(id));
    return;
  }
  if (card && !e.target.closest("a") && !e.target.closest("[data-act]") && !e.target.closest(".chip")) {
    openRepo(Number(card.dataset.id));
  }
});

function showView(v) {
  $("#viewRepos").hidden = v !== "repos";
  $("#viewDiscover").hidden = v !== "discover";
  $("#viewReleases").hidden = v !== "releases";
}

let qTimer;
$("#q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    state.q = e.target.value;
    await loadRepos();
  }, 220);
});
$("#sort").addEventListener("change", async (e) => {
  state.sort = e.target.value;
  await loadRepos();
});
$("#resetFilters").addEventListener("click", async () => {
  state.q = ""; state.tag = ""; state.lang = ""; state.scope = "all";
  $("#q").value = "";
  document.querySelectorAll("[data-scope]").forEach((b) => b.classList.toggle("active", b.dataset.scope === "all"));
  showView("repos");
  state.view = "repos";
  await refresh();
});
$("#dGo").addEventListener("click", loadDiscover);
$("#dSort").addEventListener("change", loadDiscover);
$("#dDays").addEventListener("change", loadDiscover);
$("#relGo").addEventListener("click", () => loadReleases(true));
$("#expBtn").addEventListener("click", () => window.open("/api/export", "_blank"));
$("#newTagBtn").addEventListener("click", async () => {
  const name = prompt("新建标签名（之后可在详情里把它挂到任意仓库）");
  if (!name || !name.trim()) return;
  try {
    await api("/api/tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    toast("标签已创建");
    await refresh(false);
  } catch (e) { toast("创建失败：" + e.message, true); }
});
$("#drawerClose").addEventListener("click", () => ($("#drawer").hidden = true));
$("#drawer").addEventListener("click", (e) => {
  if (e.target.id === "drawer") $("#drawer").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#drawer").hidden = true;
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
    e.preventDefault();
    $("#q").focus();
  }
});
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = cur;
  localStorage.setItem("radar-theme", cur);
});
document.documentElement.dataset.theme = localStorage.getItem("radar-theme") || "dark";

/* 同步 + SSE 进度 */
$("#syncBtn").addEventListener("click", async () => {
  try {
    await api("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "all" }) });
    toast("同步已开始，进度见左下角");
  } catch (e) {
    toast("启动同步失败：" + e.message, true);
  }
});
let esRetry = 0;
let esCurrent = null;
function listenEvents() {
  // 防错误风暴：连续失败时指数退避（5s→10s→20s→40s，封顶 60s），
  // 连不上就别再打 CPU。成功收到消息后重置计数。
  if (esCurrent) { try { esCurrent.close(); } catch {} esCurrent = null; }
  const es = new EventSource("/api/events");
  esCurrent = es;
  es.onopen = () => { esRetry = 0; };
  es.onmessage = (ev) => {
    esRetry = 0;
    const d = JSON.parse(ev.data);
    if (d.type === "progress" || d.type === "done" || d.type === "hello") {
      if (state.status) {
        state.status.sync = d;
        renderSide();
      }
      if (d.type === "done") {
        if (d.error) toast("同步失败：" + d.error, true);
        else toast("同步完成");
        refresh();
      }
    }
  };
  es.onerror = () => {
    es.close();
    esCurrent = null;
    esRetry++;
    const delay = Math.min(5000 * Math.pow(2, esRetry - 1), 60000);
    setTimeout(listenEvents, delay);
  };
}

/* ---- 登录态：侧栏显示当前用户 + 退出 ---- */
async function loadUser() {
  try {
    const st = await api("/api/auth/state");
    const box = $("#userbox");
    if (!box) return;
    if (st.authed) {
      box.hidden = false;
      $("#userLogin").textContent = st.login || "已登录";
      const av = $("#userAvatar");
      av.src = st.login ? `https://github.com/${st.login}.png?size=40` : "";
      av.style.display = st.login ? "" : "none";
    } else {
      box.hidden = true;
    }
  } catch {}
}
const logoutBtn = $("#logoutBtn");
if (logoutBtn) {
  logoutBtn.onclick = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  };
}

(async () => {
  try {
    await refresh();
    await loadUser();
  } catch (e) {
    if (e.message !== "未登录") toast("初始化失败：" + e.message, true);
    return;
  }
  listenEvents();
})();
