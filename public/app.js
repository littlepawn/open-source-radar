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
  // 列表过滤器（待读 / 停滞 / 已放弃）。和 view 分开：view 决定「显示哪块面板」，
  // filter 决定「同一块列表里筛什么」。早先混用导致 data-view="toread" 走到
  // showView 里找不到对应面板，整页 hidden 全白。
  filter: "",
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
  // 待办与体检的四个计数：后端一次算好，前端只负责摆，别各算一套
  const c = st.counts || {};
  if ($("#nToread")) $("#nToread").textContent = c.toread || 0;
  if ($("#nStale")) $("#nStale").textContent = c.stale || 0;
  if ($("#nDropped")) $("#nDropped").textContent = c.dropped || 0;
  const tags = st.tags || [];
  state.tags = tags;
  $("#tagCount").textContent = tags.length ? `${tags.length}` : "";
  const maxN = Math.max(1, ...tags.map((t) => t.n));
  // 两级标签：后端已按「父在前、子紧随」排好序，这里只加缩进。
  // 子标签的 n 是它自己挂的仓库数，不含父标签的——点父标签时后端会把子标签一起算进去。
  $("#tagList").innerHTML = tags
    .filter((t) => t.n > 0)
    .map((t) => {
      const child = t.parent ? " chip-sub" : "";
      const title = t.parent ? ` title="属于「${esc(t.parent)}」"` : "";
      return `<button class="chip${child} ${state.tag === t.name ? "active" : ""}" data-tag="${esc(t.name)}"${title}
        ${t.color ? `data-color="${esc(t.color)}"` : ""}>${esc(t.name)}<b>${t.n}</b></button>`;
    })
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
      ${r.toread ? '<span class="badge todo">待读</span>' : ""}
      ${r.dropped ? '<span class="badge arch">已放弃</span>' : ""}
      ${r.fork_behind > 0 ? `<span class="badge warn" title="上游有 ${r.fork_behind} 个提交没合进来">落后 ${r.fork_behind}</span>` : ""}
    </div>
    ${head ? `<div class="digest">${esc(head)}${tail ? `<span class="stat">${esc(tail)}</span>` : ""}</div>`
           : `<div class="desc">${esc(r.description || "（无描述）")}</div>`}
    ${r.note ? `<div class="note" title="我的备注">✎ ${esc(r.note)}</div>` : ""}
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
  // 待读 / 停滞 / 已放弃：走服务端的 view 过滤，不在这儿再筛一遍
  if (state.filter) q.set("view", state.filter);
  const d = await api("/api/repos?" + q.toString());
  state.items = d.items || [];
  $("#cards").innerHTML = state.items.map((r) => cardHTML(r)).join("");
  $("#empty").hidden = state.items.length > 0;
  const bits = [`<b>${state.items.length}</b> 个仓库`];
  const FILTER_LABEL = { toread: "待读队列", stale: "停滞超半年", dropped: "已放弃" };
  if (state.filter) bits.push(`视图 <b>${FILTER_LABEL[state.filter] || state.filter}</b>`);
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
    ${statusLine(r)}
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
      <label>我的备注（这个库我当时想拿它做什么）</label>
      <textarea id="noteEdit" rows="3" placeholder="例如：打算接进看山工具的同步链路；先观望 2.0">${esc(r.note || "")}</textarea>
      <div class="btnrow"><button class="primary" id="noteSave">保存备注</button>
        <span class="minihint">备注会显示在卡片上，搜索也能搜到</span></div>
    </div>
    <div class="sec">
      <label>README</label>
      <div class="readme" id="readmeBox">加载中…</div>
    </div>
    ${similarBlock(r)}
    ${aiBlock(r)}
    <div class="sec btnrow">
      <button class="ghost" id="toreadBtn">${r.toread ? "移出待读" : "加入待读"}</button>
      <button class="ghost" id="dropBtn">${r.dropped ? "取消放弃标记" : "标记放弃"}</button>
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

  $("#noteSave").onclick = async () => {
    const note = $("#noteEdit").value.trim();
    await api("/api/repo/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: r.id, note }),
    });
    toast("备注已保存");
    await refresh(false);
  };

  // 待读 / 放弃：只改标记，抽屉内容就地更新，不重开（重开会把 README 重拉一遍）
  const flag = async (patch) => {
    try {
      const d = await api("/api/repo/flag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: r.id, ...patch }),
      });
      Object.assign(r, d);
      $("#toreadBtn").textContent = r.toread ? "移出待读" : "加入待读";
      $("#dropBtn").textContent = r.dropped ? "取消放弃标记" : "标记放弃";
      await refresh(false);
    } catch (e) { toast("操作失败：" + e.message, true); }
  };
  $("#toreadBtn").onclick = () => flag({ toread: !r.toread });
  $("#dropBtn").onclick = () => flag({ dropped: !r.dropped });

  const ask = async () => {
    const q = $("#aiQ").value.trim();
    if (!q) return;
    const box = $("#aiChat");
    $("#aiQ").value = "";
    aiState.history.push({ role: "user", content: q });
    box.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(q)}</div><div class="msg assistant pending">思考中…</div>`);
    $("#aiChatHint").textContent = "已把 README 与关键文件交给模型，首次通常 5-20 秒";
    $("#aiAsk").disabled = true;
    try {
      const d = await api("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: r.id, question: q, history: aiState.history.slice(0, -1) }),
      });
      aiState.history.push({ role: "assistant", content: d.answer });
      box.querySelector(".pending")?.remove();
      box.insertAdjacentHTML("beforeend", `<div class="msg assistant">${RadarMD.markdown(d.answer)}</div>`);
      $("#aiChatHint").textContent = d.usage ? `本次 ${d.usage.total_tokens} tokens · ${d.model}` : "";
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      box.querySelector(".pending")?.remove();
      box.insertAdjacentHTML("beforeend", `<div class="msg err">失败：${esc(e.message)}</div>`);
      $("#aiChatHint").textContent = "";
    } finally {
      $("#aiAsk").disabled = false;
    }
  };
  const askBtn = $("#aiAsk");
  if (askBtn) askBtn.onclick = ask;
  const aiQ = $("#aiQ");
  if (aiQ) aiQ.onkeydown = (e) => { if (e.key === "Enter") ask(); };

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

/* 抽屉里那行「这库现在什么状态」：打开过几次、多久没动、fork 落后多少。
   数据来自 /api/repo/:id 的 open_count / stagnation / fork_lag，前端只做展示不做判断，
   免得和 lib/insight.mjs 的判据跑偏成第二套。 */
function statusLine(r) {
  const bits = [];
  if (r.open_count) bits.push(`打开 ${r.open_count} 次`);
  // 必须判 stale：stagnation() 无论如何都返回对象，只看「有没有对象」会把
  // 昨天刚推送的仓库也标成停滞。文案用 reason，那是后端算好的可读结论。
  if (r.stagnation?.stale) bits.push(`<span class="warn">⏸ ${esc(r.stagnation.reason || "停滞")}</span>`);
  if (r.fork_lag) {
    if (r.fork_lag.behind > 0) bits.push(`<span class="warn">上游领先 ${r.fork_lag.behind} 个提交</span>`);
    else if (r.fork_lag.ahead > 0) bits.push(`本地领先上游 ${r.fork_lag.ahead} 个提交`);
  }
  if (r.ai_summary) bits.push("已有 AI 结论");
  return bits.length ? `<div class="statusline">${bits.join(" · ")}</div>` : "";
}

function similarBlock(r) {
  const list = r.similar || [];
  if (!list.length) return "";
  return `<div class="sec">
    <label>收藏里还有这些（按语言 / topics / 标签重叠加权）</label>
    <div class="rowtags">${list.map((x) =>
      `<button class="chip" data-open="${x.id}" title="${esc(x.full_name)}">${esc(x.full_name.split("/")[1])} · ${Math.round(x.score * 100)}%</button>`).join("")}</div>
  </div>`;
}

function aiBlock(r) {
  if (!(state.status?.ai_enabled)) {
    return `<div class="sec">
      <label>问 AI</label>
      <div class="minihint">还没配 AI。<button class="link" data-view="ai">去填 Base URL / 模型 / Key</button>，配好后这里能直接问这个库的细节。</div>
    </div>`;
  }
  // 一次对话的多轮历史留在 DOM 里，换仓库就重置（key 是 repo id）
  if (aiState.repoId !== r.id) { aiState.repoId = r.id; aiState.history = []; }
  return `<div class="sec">
    <label>问 AI（已带上 README、目录与关键文件）</label>
    <div class="aichat" id="aiChat">${aiState.history.map((m) =>
      `<div class="msg ${m.role}">${m.role === "user" ? esc(m.content) : RadarMD.markdown(m.content)}</div>`).join("")}</div>
    <div class="btnrow">
      <input id="aiQ" placeholder="例如：生产环境敢用吗，坑在哪？（回车发送）" autocomplete="off" />
      <button class="primary" id="aiAsk">发送</button>
    </div>
    <div class="minihint" id="aiChatHint"></div>
  </div>`;
}

const aiState = { repoId: null, history: [] };

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

// README 渲染器已抽到 /md.js（UMD，浏览器与 bun test 共用同一份实现）。
// 这里只留一层兜底外壳：万一副本被拦截（CSP/离线），退化成转义后的纯文本，
// 而不是把整块 README 打空白。
function miniMarkdown(md, base) {
  if (globalThis.RadarMD && typeof RadarMD.markdown === "function") return RadarMD.markdown(md, base);
  return `<pre>${esc(String(md || "")).slice(0, 200000)}</pre>`;
}

// 自定义查询框非空时，下拉（排序/时间窗）完全不参与查询构建，
// 但下拉仍原样显示，用户会以为是「最近活跃 · >200★ + 近1年新建」在生效。
// 所以把真实生效条件分开写清楚。
const DISCOVER_STARS = { stars: ">2000", updated: ">200" };
function discoverConditionNote() {
  if ($("#dQ").value.trim()) return "自定义语法（两个下拉不参与）";
  const s = $("#dSort").value;
  const d = $("#dDays").value;
  const win = { 90: "近 3 个月", 365: "近 1 年", 1825: "近 5 年" }[d] || `近 ${d} 天`;
  return `${s === "stars" ? "总 Star 榜" : "最近活跃"} · Star ${DISCOVER_STARS[s] || ""} · ${win}内新建`;
}

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
      `<div class="crumb spanall">查询条件 <b>${esc(d.query)}</b> · 条件来源 <b>${esc(discoverConditionNote())}</b> · 命中 <b>${fmt(d.total)}</b> 个仓库${d.rate?.remaining != null ? ` · 搜索配额剩余 ${d.rate.remaining}` : ""}</div>` +
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

/* ---------------- 停滞 / 清理建议 / AI 设置 */
// 停滞视图走的是主列表（#viewRepos），只是多一个 filter。
// 早先它自己 showView("repos") 又把 state.scope 写成 "stale"——scope 是 source 参数，
// 之后一搜索就变成 source=stale，查询直接空。
async function loadStale() {
  state.filter = "stale";
  state.scope = "all";
  state.view = "repos";
  showView("repos");
  await loadRepos();
  if (!$("#staleHint").textContent) {
    $("#staleHint").textContent = "点右侧按钮可逐个数一下 fork 落后上游多少提交";
  }
}

async function loadCleanup(run) {
  const hint = $("#cleanupHint");
  if (run) {
    hint.textContent = "正在算…";
    $("#cleanupGo").disabled = true;
  }
  try {
    const d = await api("/api/cleanup");
    if (run) hint.textContent = `共 ${d.total} 个库，${d.count} 个进入候选`;
    $("#cleanupList").innerHTML = d.items.length
      ? d.items.map((c) => `<article class="card" data-id="${c.id}" data-ctx="repo">
          <div class="name"><a href="${esc(c.html_url || "#")}" target="_blank" rel="noreferrer" data-stop>${esc(c.full_name || c.id)}</a>
            ${c.language ? `<span class="badge">${esc(c.language)}</span>` : ""}
            ${c.archived ? '<span class="badge arch">归档</span>' : ""}
            <span class="badge warn">${(c.signals || []).length} 条信号</span></div>
          ${c.digest ? `<div class="digest">${esc(c.digest.split("\n")[0])}</div>` : `<div class="desc">${esc(c.description || "（无描述）")}</div>`}
          <div class="desc">${esc((c.signals || []).join(" · ") || "—")}</div>
          <div class="foot"><span>★ ${fmt(c.stars)}</span><span class="lang">${esc(c.language || "—")}</span>
            <span>最后推送 ${ago(c.pushed_at)}</span><span class="sp"></span>
            <button class="act" data-act="open">详情</button></div>
        </article>`).join("")
      : `<div class="empty">没有命中清理信号。判定标准：长期没推送、从没打开过、已归档、已放弃——命中两条以上才算候选。</div>`;
  } catch (e) {
    hint.textContent = "失败：" + e.message;
  } finally {
    if (run) $("#cleanupGo").disabled = false;
  }
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
  const navFilter = e.target.closest("[data-filter]");
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
  // 相似仓库 chip：直接换抽屉内容
  const simBtn = e.target.closest("[data-open]");
  if (simBtn) {
    $("#drawer").hidden = true;
    await openRepo(Number(simBtn.dataset.open));
    return;
  }
  // 待读 / 停滞 / 已放弃：同一块主列表换个服务端 view 参数。
  // 再点一次同一个就取消过滤，回到全部。
  if (navFilter) {
    const f = navFilter.dataset.filter;
    state.filter = state.filter === f ? "" : f;
    state.scope = "all";
    state.view = "repos";
    showView("repos");
    document.querySelectorAll("[data-filter]").forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === state.filter));
    document.querySelectorAll("[data-scope]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("active"));
    await refresh();
    return;
  }
  if (navScope) {
    state.scope = navScope.dataset.scope;
    state.tag = "";
    state.filter = "";        // 换分区时清掉待读/停滞过滤，否则列表会莫名少一半
    state.view = "repos";
    showView("repos");
    document.querySelectorAll("[data-scope]").forEach((b) => b.classList.toggle("active", b === navScope));
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
    await refresh();
    return;
  }
  if (navView) {
    state.view = navView.dataset.view;
    // 进独立面板前把列表过滤器清掉，回来时才不会带着上次的 view 参数
    state.filter = "";
    // 抽屉里也有 data-view（比如「去配 AI」），不关抽屉的话新面板被盖在下面
    $("#drawer").hidden = true;
    document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
    showView(state.view);
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("active", b === navView));
    document.querySelectorAll("[data-scope]").forEach((b) => b.classList.remove("active"));
    if (state.view === "discover") await loadDiscover();
    if (state.view === "releases") await loadReleases(false);
    if (state.view === "cleanup") await loadCleanup(false);
    if (state.view === "ai" && window.RadarAI) await RadarAI.reload();
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
  const map = {
    repos: "#viewRepos", discover: "#viewDiscover", releases: "#viewReleases",
    cleanup: "#viewCleanup", ai: "#viewAI",
  };
  for (const [k, sel] of Object.entries(map)) {
    const el = $(sel);
    if (el) el.hidden = k !== v;
  }
  // 停滞不是独立面板，它就是主列表 + 一条工具行
  const bar = $("#staleBar");
  if (bar) bar.hidden = state.filter !== "stale";
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
  state.q = ""; state.tag = ""; state.lang = ""; state.scope = "all"; state.filter = "";
  $("#q").value = "";
  document.querySelectorAll("[data-scope]").forEach((b) => b.classList.toggle("active", b.dataset.scope === "all"));
  document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("active"));
  showView("repos");
  state.view = "repos";
  await refresh();
});
$("#dGo").addEventListener("click", loadDiscover);
$("#dSort").addEventListener("change", loadDiscover);
$("#dDays").addEventListener("change", loadDiscover);
$("#relGo").addEventListener("click", () => loadReleases(true));
$("#cleanupGo").addEventListener("click", () => loadCleanup(true));
$("#staleForkGo").addEventListener("click", async () => {
  const hint = $("#staleHint");
  hint.textContent = "对比中（每个 fork 一次 compare 调用）…";
  $("#staleForkGo").disabled = true;
  try {
    const d = await api("/api/fork/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 50 }) });
    const ok = d.items.filter((x) => !x.error);
    const behind = ok.filter((x) => x.behind > 0);
    hint.textContent = `比了 ${ok.length} 个，${behind.length} 个落后上游` +
      (d.items.length > ok.length ? `（${d.items.length - ok.length} 个失败）` : "");
    await loadStale();
  } catch (e) {
    hint.textContent = "失败：" + e.message;
  } finally {
    $("#staleForkGo").disabled = false;
  }
});
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
