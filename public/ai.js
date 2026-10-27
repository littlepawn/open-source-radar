/* 开源雷达 · AI 设置页的独立脚本。
   放在单独文件而不是塞进 app.js，是为了让 app.js 只处理列表与抽屉；
   这个文件挂了也不影响主界面（CSP 下 script-src 'self'，不能内联）。 */
(() => {
  const $ = (s) => document.querySelector(s);
  const api = async (p, opt) => {
    const r = await fetch(p, opt);
    const t = await r.text();
    let d;
    try { d = JSON.parse(t); } catch { d = t; }
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    return d;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let presets = [];
  let defaultPrompt = "";

  async function load() {
    if (!$("#aiBase")) return;
    try {
      const cfg = await api("/api/ai/config");
      presets = cfg.presets || [];
      defaultPrompt = cfg.default_extra_prompt || "";
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
        };
        $("#aiBase").oninput = () => {
          const p = presets.find((x) => x.id === sel.value);
          if (p && p.base_url !== $("#aiBase").value) sel.value = "";
        };
      }
      $("#aiEnabled").checked = !!cfg.enabled;
      $("#aiBase").value = cfg.base_url || "";
      // 按已保存的 base_url 反选预设，否则重新进设置页下拉永远显示「自定义」，
      // 用户看不出当前用的是哪家
      if (sel.options.length > 1 && !sel.value) {
        const hit = presets.find((p) => p.base_url && p.base_url === cfg.base_url);
        sel.value = hit ? hit.id : "";
      }
      $("#aiModel").value = cfg.model || "";
      $("#aiTemp").value = cfg.temperature ?? 0.2;
      $("#aiMax").value = cfg.max_tokens ?? 2000;
      $("#aiExtra").value = cfg.extra_prompt || "";
      $("#aiKey").value = "";
      // 后端只回 has_key 布尔，不回明文 Key —— 前端永远拿不到它
      $("#aiKey").placeholder = cfg.has_key ? "已保存 Key（留空＝不修改）" : "粘贴 API Key";
      $("#aiHint").textContent = cfg.enabled ? `已启用 · ${cfg.model || "未填模型"}` : "未启用";
    } catch (e) {
      $("#aiHint").textContent = "读取配置失败：" + e.message;
    }
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
      await load();
    } catch (e) {
      $("#aiHint").textContent = "保存失败：" + e.message;
    }
  }

  async function test() {
    $("#aiHint").textContent = "测试中…";
    try {
      const d = await api("/api/ai/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      $("#aiHint").textContent = `通了：${d.reply}（${d.model}）`;
    } catch (e) {
      $("#aiHint").textContent = "不通：" + e.message;
    }
  }

  // 向上游要模型列表，填进 datalist（可下拉可手输，两边都不耽误）
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
      hint.textContent = "拉取失败：" + e.message;
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
  });
  // 打开「AI 设置」视图时要重新读一次（可能被别人改过）
  window.RadarAI = { reload: load };
})();
