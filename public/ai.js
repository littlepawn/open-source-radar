/* 开源雷达 · AI 设置页的独立脚本。
   放在单独文件而不是塞进 app.js，是为了让 app.js 只处理列表与抽屉；
   这个文件挂了也不影响主界面（CSP 下 script-src 'self'，不能内联）。 */
(() => {
  const $ = (s) => document.querySelector(s);
  // 本页三个请求都会打到上游 AI（test/chat 最长 120s，拉模型列表也要几秒）。
  // 不设超时的话网络挂住时 UI 会永远停在「测试中…」，只能刷新页面。
  const api = async (p, opt = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 130000);   // 略大于服务端 120s
    let r;
    try {
      r = await fetch(p, { ...opt, signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(ac.signal.aborted ? "请求超时（超过 130 秒），请检查上游是否可达" : e.message);
    }
    clearTimeout(timer);
    const t = await r.text();
    let d;
    try { d = JSON.parse(t); } catch { d = t; }
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    return d;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let presets = [];
  let defaultPrompt = "";
  let providerKind = "openai";   // 后端 matchProvider() 判定，见 /api/ai/config 的 provider_kind
  let providerLabel = "";

  // 用户动过的字段。每次进设置页都会 load() 一次，若无条件回填，
  // 用户填一半切走再回来就被冲成已保存的值——和发现页阈值被重置是同一类问题。
  const dirty = new Set();
  const isDirty = () => dirty.size > 0;
  const TRACKED = ["#aiBase", "#aiModel", "#aiTemp", "#aiMax", "#aiExtra", "#aiKey"];

  // 按指纹比对：值没变就不算「用户改过」，避免程序化回填自己把自己标脏。
  function watchDirty() {
    for (const id of TRACKED) {
      const el = $(id);
      if (!el || el.dataset.watching) continue;
      el.dataset.watching = "1";
      const mark = () => {
        if (el.value !== (el.dataset.baseline ?? "")) dirty.add(id);
        else dirty.delete(id);
      };
      el.addEventListener("input", mark);
      el.addEventListener("change", mark);
    }
  }

  function setField(sel, value, { force = false } = {}) {
    const el = $(sel);
    if (!el) return;
    const on = Array.from(TRACKED).indexOf(sel) >= 0;
    if (on && !force && dirty.has(sel)) return;   // 用户改过，别冲掉
    el.value = value;
    el.dataset.baseline = el.value;
    if (on) dirty.delete(sel);
  }

  async function load(force = false) {
    if (!$("#aiBase")) return;
    if (force) dirty.clear();   // 保存成功后重读：以服务端为准，清掉脏标记后正常回填
    try {
      const cfg = await api("/api/ai/config");
      presets = cfg.presets || [];
      defaultPrompt = cfg.default_extra_prompt || "";
      providerKind = cfg.provider_kind || "openai";
      providerLabel = cfg.provider_label || "";
      const sel = $("#aiPreset");
      // 选项只建一次：重复 innerHTML 会把用户当前选中项冲掉。
      // 判断用「只有占位项」而不是 !options.length——HTML 里已经预置了
      // <option value="">自定义</option> 兜底，length 永远不是 0，
      // 之前正是这个条件让预设列表一整个建不出来（下拉空白）。
      if (sel.options.length <= 1) {
        sel.innerHTML = `<option value="">自定义</option>` +
          presets.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
        sel.onchange = () => {
          const p = presets.find((x) => x.id === sel.value);
          if (!p) return;
          $("#aiBase").value = p.base_url || "";
          $("#aiModel").value = p.model || "";
          $("#aiHint").textContent = p.note || "";
          updateProviderNote($("#aiBase").value);
          // 程序化改 value 不会触发 input 事件，watchDirty 收不到 → 用户点了预设
          // 却没法保存。手动补一次 change，让「保存」按钮亮起来。
          for (const el of [$("#aiBase"), $("#aiModel")]) el?.dispatchEvent(new Event("change", { bubbles: true }));
        };
        $("#aiBase").oninput = () => {
          const p = presets.find((x) => x.id === sel.value);
          if (p && p.base_url !== $("#aiBase").value) sel.value = "";
          updateProviderNote($("#aiBase").value);
        };
      }
      // 开关也算用户输入：load() 每次都跑，不加这层判断会把用户刚勾的选择冲回去
      if (!$("#aiEnabled").dataset.touched) $("#aiEnabled").checked = !!cfg.enabled;
      setField("#aiBase", cfg.base_url || "");
      // 按已保存的 base_url 反选预设，否则重新进设置页下拉永远显示「自定义」，
      // 用户看不出当前用的是哪家
      if (sel.options.length > 1 && !sel.value) {
        const hit = presets.find((p) => p.base_url && p.base_url.replace(/\/+$/, "") === (cfg.base_url || "").replace(/\/+$/, ""));
        sel.value = hit ? hit.id : "";
      }
      setField("#aiModel", cfg.model || "");
      setField("#aiTemp", String(cfg.temperature ?? 0.2));
      setField("#aiMax", String(cfg.max_tokens ?? 2000));
      setField("#aiExtra", cfg.extra_prompt || "");
      // Key 永不回填明文；用户已手输的也不清空
      if (!dirty.has("#aiKey") || !$("#aiKey").value) $("#aiKey").value = "";
      // 后端只回 has_key 布尔，不回明文 Key —— 前端永远拿不到它
      $("#aiKey").placeholder = cfg.has_key ? "已保存 Key（留空＝不修改）" : "粘贴 API Key";
      $("#aiHint").textContent = cfg.enabled ? `已启用 · ${cfg.model || "未填模型"}` : "未启用";
      updateProviderNote(cfg.base_url);
      watchDirty();
    } catch (e) {
      $("#aiHint").textContent = "读取配置失败：" + e.message;
    }
  }

  /* 服务商提示。对齐 Open WebUI 的「验证失败 ≠ 配不了」结论：
     Anthropic 原生端点不是 OpenAI 协议（必须换兼容端点才能用）；
     Perplexity / GitHub Models / MiniMax 不提供标准 /models（模型要手填，
     但 chat 本身可用）；其余按标准协议处理，/models 能拉就拉。 */
  function updateProviderNote(baseUrl) {
    const el = $("#aiProviderNote");
    if (!el) return;
    const u = String(baseUrl || "").trim();
    if (!u) { el.textContent = ""; el.hidden = true; return; }
    let host = "";
    try { host = new URL(u).hostname; } catch { host = ""; }
    const NOTES = {
      "api.anthropic.com": "这是 Anthropic 原生端点，不是 OpenAI 协议，本页用不了。要用 Claude 请填兼容端点（如官方的 /v1 OpenAI 兼容层，或经 LiteLLM / oneAPI 中转）。",
      "api.perplexity.ai": "Perplexity 不提供标准 /models 列表，「拉取」会失败——这是它家的问题不是配置错了。直接手填模型名（如 sonar-pro），对话本身可用。",
      "api.minimax.chat": "MiniMax 不提供标准 /models 列表，请直接手填模型名（如 abab6.5s-chat）。",
      "api.minimaxi.com": "MiniMax 不提供标准 /models 列表，请直接手填模型名（如 abab6.5s-chat）。",
    };
    if (NOTES[host]) { el.textContent = NOTES[host]; el.hidden = false; return; }
    if (/models\.github\.ai|models\.inference\.ai\.azure\.com/.test(host)) {
      el.textContent = "GitHub Models 不提供标准 /models 列表，请手填模型名（如 openai/gpt-4o-mini）。";
      el.hidden = false;
      return;
    }
    el.textContent = "";
    el.hidden = true;
  }

  async function save() {
    const body = {
      enabled: $("#aiEnabled").checked,
      base_url: $("#aiBase").value.trim(),
      model: $("#aiModel").value.trim(),
      temperature: Number($("#aiTemp").value || 0.2),
      max_tokens: Number($("#aiMax").value || 2000),
      extra_prompt: $("#aiExtra").value,
    };
    const key = $("#aiKey").value.trim();
    if (key) body.api_key = key;   // 留空＝保留已存的 Key
    try {
      await api("/api/ai/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      $("#aiHint").textContent = "已保存";
      await load(true);   // 保存后以服务端为准重读，否则用户改过的字段会被 dirty 挡住不刷新
    } catch (e) {
      $("#aiHint").textContent = "保存失败：" + e.message;
    }
  }

  async function test() {
    // 服务端 /api/ai/test 只读已保存的配置，不看请求体。用户改了 Base URL 没保存就点
    // 「测试连通」，测的其实是旧值——提示必须说清楚，否则「改了不通 / 改了通了」都对不上。
    if (isDirty()) {
      $("#aiHint").textContent = "有未保存的改动，请先点「保存」再测试（测试用的是已保存的配置）";
      return;
    }
    $("#aiHint").textContent = "测试中…";
    try {
      const d = await api("/api/ai/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      $("#aiHint").textContent = `通了：${d.reply}（${d.model}）`;
    } catch (e) {
      $("#aiHint").textContent = "不通：" + e.message;
    }
  }

  // 向上游要模型列表，填进 datalist（可下拉可手输，两边都不耽误）。
  // 拉取失败≠配置错：Open WebUI 文档明确说明部分服务商不提供 /models，
  // 此时按提示手填模型名即可，对话本身可用。
  async function fetchModels() {
    const btn = $("#aiFetchModels");
    const hint = $("#aiHint");
    hint.textContent = "正在向上游要模型列表…";
    btn.disabled = true;
    try {
      const d = await api("/api/ai/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base_url: $("#aiBase").value.trim(),
          api_key: $("#aiKey").value.trim(),
        }),
      });
      $("#aiModelList").innerHTML = d.models.map((m) => `<option value="${esc(m)}"></option>`).join("");
      hint.textContent = `拉到 ${d.models.length} 个模型，点模型框可选`;
      // 只有一个候选就没得选，直接填上省一次点击
      if (d.models.length === 1) $("#aiModel").value = d.models[0];
    } catch (e) {
      const msg = String(e.message || "");
      // 401/403 才是配置错；404/400 多半是这家不提供 /models，引导手填
      if (/上游 (404|400|405)/.test(msg)) {
        hint.textContent = "这家服务商不提供标准的 /models 列表（拉取失败≠配置错），直接手填模型名即可，对话可用。";
      } else {
        hint.textContent = "拉取失败：" + msg;
      }
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const b = $("#aiSave");
    if (b) b.onclick = save;
    const t = $("#aiTest");
    if (t) t.onclick = test;
    const f = $("#aiFetchModels");
    if (f) f.onclick = fetchModels;
    const r = $("#aiPromptReset");
    if (r) r.onclick = () => {
      $("#aiExtra").value = defaultPrompt;
      $("#aiHint").textContent = "已填回默认分析提示词，记得保存";
    };
    const en = $("#aiEnabled");
    if (en) en.addEventListener("change", () => { en.dataset.touched = "1"; });
    bindAutoSync();
    load();
  });

  /* ---------------- 自动同步设置 ---------------- */
  let asCfg = { min_interval: 15, max_interval: 1440, default_interval: 120 };

  function markQuick(min) {
    for (const c of document.querySelectorAll("#asQuick .chip")) {
      c.classList.toggle("active", Number(c.dataset.min) === Number(min));
    }
  }

  // 把后端的原始错误压成一句人话：GitHub 的响应体是 JSON，
  // 直接塞进提示条会是一坨带转义的 `{ "message": ... }`，读不出重点。
  function shortError(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const m = s.match(/"message"\s*:\s*"([^"]+)"/);
    if (m) {
      const code = (s.match(/GitHub (\d{3})/) || [])[1];
      return code ? `${code} ${m[1]}` : m[1];
    }
    return s.split("\n")[0].slice(0, 160);
  }

  function renderNext(d) {
    const el = $("#asNext");
    const errEl = $("#asError");
    if (!el) return;
    // 上次同步失败要说出来：否则用户只看到数字不刷新，不知道是间隔没到还是同步一直失败
    if (errEl) {
      const e = shortError(d.last_error);
      errEl.hidden = !e;
      errEl.textContent = e ? `上次自动同步失败：${e}` : "";
    }
    if (!d.enabled) { el.textContent = "自动同步已关闭，只能手动点「同步 GitHub」。"; return; }
    if (!d.next_run_at) { el.textContent = ""; return; }
    const mins = Math.max(0, Math.round((d.next_run_at - Date.now()) / 60000));
    const when = mins <= 0 ? "即将开始" : mins < 60 ? `${mins} 分钟后` : `${(mins / 60).toFixed(1)} 小时后`;
    el.textContent = `下次自动同步：${when}（每 ${humanInterval(d.interval)}）`;
  }

  // 与 lib/schedule.mjs 的 humanInterval 一致：设置页要显示「2 小时」而不是「120 分钟」
  function humanInterval(min) {
    const n = Math.max(1, Math.round(Number(min) || 0));
    if (n < 60) return `${n} 分钟`;
    const h = n / 60;
    return Number.isInteger(h) ? `${h} 小时` : `${Math.floor(h)} 小时 ${n % 60} 分钟`;
  }

  async function loadAutoSync() {
    if (!$("#asEnabled")) return;
    try {
      const d = await api("/api/settings/autosync");
      asCfg = { ...asCfg, ...d };
      $("#asEnabled").checked = !!d.enabled;
      $("#asInterval").value = d.interval;
      $("#asInterval").min = d.min_interval;
      $("#asInterval").max = d.max_interval;
      markQuick(d.interval);
      renderNext(d);
      $("#asHint").textContent = "";
    } catch (e) {
      $("#asHint").textContent = "读取失败：" + e.message;
    }
  }

  async function saveAutoSync() {
    const raw = Number($("#asInterval").value);
    if (!Number.isFinite(raw) || raw <= 0) { $("#asHint").textContent = "请填一个正的分钟数"; return; }
    try {
      const d = await api("/api/settings/autosync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: $("#asEnabled").checked, interval: raw }),
      });
      // 后端会把越界值收敛后回填，所以要按返回值重绘，别按用户输入显示
      $("#asInterval").value = d.interval;
      markQuick(d.interval);
      renderNext(d);
      $("#asHint").textContent = d.interval !== Math.round(raw)
        ? `已保存（${raw} 分钟超出范围，按${humanInterval(d.interval)}执行）`
        : "已保存";
    } catch (e) {
      $("#asHint").textContent = "保存失败：" + e.message;
    }
  }

  function bindAutoSync() {
    if (!$("#asEnabled")) return;
    $("#asSave").onclick = saveAutoSync;
    $("#asEnabled").onchange = saveAutoSync;
    for (const c of document.querySelectorAll("#asQuick .chip")) {
      c.onclick = () => {
        $("#asInterval").value = c.dataset.min;
        markQuick(c.dataset.min);
        saveAutoSync();
      };
    }
    loadAutoSync();
  }
  // 打开「AI 设置」视图时要重新读一次（可能被别人改过）
  window.RadarAI = { reload: load, reloadSync: loadAutoSync };
})();
