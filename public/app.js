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
  const tags = st.tags || [];
  state.tags = tags;
  $("#tagCount").textContent = tags.length ? `${tags.length}` : "";
  const maxN = Math.max(1, ...tags.map((t) => t.n));
  $("#tagList").innerHTML = tags
    .filter((t) => t.n > 0)
    .map(
      (t) => `<button class="chip ${state.tag === t.name ? "active" : ""}" data-tag="${esc(t.name)}"
        style="${t.color ? `border-color:${esc(t.color)};color:${esc(t.color)}` : ""}">${esc(t.name)}<b>${t.n}</b></button>`
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
  const r = await api(`/api/repo/${id}`);
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
      <div style="margin-top:8px;display:flex;gap:8px">
        <button class="primary" id="digSave">保存简介</button>
        <button class="ghost" id="digRule">用规则重算</button>
      </div>
    </div>
    <div class="sec">
      <label>标签（点选切换，输入新标签回车创建）</label>
      <div class="rowtags" id="tagEditor">
        ${[...new Set([...tags, ...allTags])].map((t) => `<button class="chip ${tags.includes(t) ? "active" : ""}" data-id2="${r.id}" data-tag2="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>
      <input id="newTag" placeholder="新标签，回车创建" style="margin-top:8px;background:var(--bg-card);border:1px solid var(--line);border-radius:9px;padding:8px 12px;width:240px" />
    </div>
    <div class="sec">
      <label>Topics</label>
      <div class="rowtags">${topics.map((t) => `<span class="chip">${esc(t)}</span>`).join("") || '<span class="minihint">无</span>'}</div>
    </div>
    <div class="sec">
      <label>README</label>
      <div class="readme" id="readmeBox">加载中…</div>
    </div>
    <div class="sec" style="display:flex;gap:8px">
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
    $("#readmeBox").innerHTML = md.markdown ? miniMarkdown(md.markdown) : "（该仓库没有 README，或已超出 200KB 截断）";
  } catch (e) {
    if (mySeq !== drawerSeq || $("#drawer").hidden) return;
    $("#readmeBox").textContent = "README 读取失败：" + e.message;
  }
}

function rulePreview(r, topics) {
  const hay = `${r.description || ""} ${topics.join(" ")} ${r.name || ""} ${r.language || ""}`.toLowerCase();
  const R = [
    [/ppt|slide|presentation|keynote|powerpoint/, "做 PPT / 演示文稿"],
    [/excel|spreadsheet|xlsx|office|docx/, "文档表格处理"],
    [/agent|langgraph|autogen/, "AI Agent 框架"],
    [/llm|gpt|claude|qwen|deepseek|inference|vllm|ollama/, "大模型推理与服务"],
    [/rag|embedding|vector|milvus|chroma|faiss/, "向量检索 / RAG"],
    [/diffusion|comfyui|flux|sdxl|image-gen/, "AI 文生图"],
    [/tts|voice|speech|whisper|asr|audio|music/, "语音合成与识别"],
    [/video|ffmpeg|subtitle|remotion/, "视频处理"],
    [/docker|kubernetes|k8s|helm|compose/, "容器与编排"],
    [/proxy|tunnel|frp|wireguard|vpn|clash|sing-box|v2ray|xray|nginx/, "网络代理 / 反代"],
    [/monitor|prometheus|grafana|uptime|alert/, "监控告警"],
    [/nas|home-assistant|homelab|self-host|dashboard/, "自托管 / 家庭服务器"],
    [/scrap|crawl|spider|puppeteer|playwright|selenium/, "抓取与浏览器自动化"],
    [/chrome|extension|userscript|tampermonkey/, "浏览器扩展"],
    [/macos|swiftui|\bios\b|iphone|uikit/, "Apple 平台应用"],
    [/android|adb|magisk|xposed|frida|root/, "安卓改造与逆向"],
    [/reverse|decompil|ghidra|\bida\b|exploit|pwn|malware/, "逆向 / 安全研究"],
    [/crypto|bitcoin|ethereum|blockchain|web3|wallet/, "区块链"],
    [/sql|database|postgres|mysql|sqlite|redis|mongo|orm/, "数据库"],
    [/terminal|shell|\bcli\b|\btui\b/, "命令行 / TUI"],
    [/editor|vim|neovim|emacs|\bide\b/, "编辑器 / IDE"],
    [/\bui\b|component|tailwind|react|vue|svelte|frontend|css/, "前端 UI / 组件"],
    [/test|e2e|cypress|jest|vitest/, "测试工程"],
    [/deploy|\bci\b|pipeline|devops/, "CI/CD"],
    [/security|vulnerab|\bcve\b|pentest|hack/, "安全攻防"],
    [/game|emulator|retro|steam/, "游戏"],
    [/download|magnet|torrent|onedrive|aliyun/, "下载 / 网盘"],
    [/translat|i18n/, "翻译"],
    [/ocr|scan/, "OCR 识别"],
  ];
  const hits = R.filter(([re]) => re.test(hay)).map((x) => x[1]).slice(0, 2);
  const d = (r.description || "").slice(0, 110);
  const head = hits.length ? `${hits.join("；")}。${d}` : d || "暂无描述。";
  return `${head}\n${r.language || "未知语言"} · ⭐ ${fmt(r.stars)} · 最后推送 ${(r.pushed_at || "").slice(0, 10)}`;
}

/* 极简 markdown：标题/列表/代码/链接/粗体，够看 README 用途 */
function miniMarkdown(md) {
  let s = esc(md.slice(0, 120000));
  s = s.replace(/<img[^>]*src="([^"]+)"[^>]*>/g, (_, src) => `<img src="${src}" loading="lazy">`);
  s = s.replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, (_, src) => `<img src="${src}" loading="lazy">`);
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/^\w*\n/, "")}</pre>`);
  s = s.replace(/^###### (.*)$/gm, "<h6>$1</h6>").replace(/^##### (.*)$/gm, "<h5>$1</h5>")
       .replace(/^#### (.*)$/gm, "<h4>$1</h4>").replace(/^### (.*)$/gm, "<h3>$1</h3>")
       .replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // 相对锚点链接 [#anchor] 与 [!badge] 之类图标语法：渲染成可点文本，避免裸露方括号
  s = s.replace(/\[([^\]]+)\]\(#([^)]*)\)/g, '<a class="mdlink" href="#$2">$1</a>');
  s = s.replace(/\[!\[[^\]]*\]\([^)]*\)\]\(([^)]+)\)/g, (m, u) =>
    safeUrl(u) ? `<a class="mdlink" href="${esc(safeUrl(u))}" target="_blank" rel="noreferrer">查看</a>` : "查看");
  s = s.replace(/\[([^\]]{1,60})\]/g, (m, t) => (t.startsWith("!") ? m : `<span class="mdlink">${t}</span>`));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/^[-*+] (.*)$/gm, "<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
  s = s.replace(/^(?!<h|<ul|<li|<pre|<img|<p)(.+)$/gm, "<p>$1</p>");
  return s;
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
      `<div class="crumb" style="grid-column:1/-1">查询条件 <b>${esc(d.query)}</b> · 命中 <b>${fmt(d.total)}</b> 个仓库${d.rate?.remaining != null ? ` · 搜索配额剩余 ${d.rate.remaining}` : ""}</div>` +
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
          <div class="foot"><a href="${esc(r.url)}" target="_blank" rel="noreferrer" style="color:var(--accent-2)">打开 Release</a><span class="sp"></span>
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
