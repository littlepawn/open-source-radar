/* 网络代理配置面板：读写 /api/proxy。与 ai.js 同风格——纯 DOM 操作，
   保存成功后以服务端返回的状态为准回填，避免「填了一个存不进去的地址却显示绿色」。 */
(() => {
  const $ = (s) => document.querySelector(s);
  let loaded = false;

  function msg(text, kind = "") {
    const el = $("#pxMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "minihint" + (kind ? " " + kind : "");
  }

  function paint(cfg) {
    const url = $("#pxUrl");
    if (!url) return;
    url.value = cfg.url || "";
    const hint = $("#pxHint");
    if (hint) {
      hint.textContent = cfg.url
        ? `当前出口：${cfg.url}${cfg.from_env ? "（由环境变量 RADAR_PROXY 覆盖，页面上改无效）" : ""}`
        : "当前出口：直连（未使用代理）";
    }
    const note = $("#pxNote");
    if (note) {
      if (cfg.in_docker) {
        note.textContent = "你在容器里运行：容器内的 127.0.0.1 指向容器自身，要用宿主地址，例如 http://host.docker.internal:7890。";
      } else {
        note.textContent = "";
      }
    }
    // 环境变量优先的部署里，前台改不了实际出口，把按钮禁掉更诚实
    const lock = !!cfg.from_env;
    for (const id of ["#pxSave", "#pxClear"]) {
      const b = $(id);
      if (b) b.disabled = lock;
    }
  }

  async function reload() {
    try {
      const r = await fetch("/api/proxy", { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      paint(d);
      loaded = true;
      // 浏览器端只用于判断「填 127.0.0.1 要换算成宿主地址」这类提示，不参与任何请求
      if (d.in_docker) document.documentElement.dataset.inDocker = "1";
    } catch (e) {
      msg("读取代理配置失败：" + e.message, "warn");
    }
  }

  async function save(url) {
    msg("保存中…");
    try {
      const r = await fetch("/api/proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ url }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      paint(d);
      msg(url ? "已保存，新的出站请求立即走这个代理。" : "已清空，恢复直连。", "ok");
    } catch (e) {
      msg("保存失败：" + e.message, "warn");
    }
  }

  async function test() {
    const url = ($("#pxUrl")?.value || "").trim();
    msg("测试中…（最多等 20 秒）");
    try {
      const r = await fetch("/api/proxy/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        // 传当前输入框的值：允许先试再存，不用来回改
        body: JSON.stringify({ url }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const target = d.url || "直连";
      if (d.ok) msg(`${target} 走得通（HTTP ${d.status}，${d.ms}ms）`, "ok");
      else msg(`${target} 不通：${d.error || "未知原因"}`, "warn");
    } catch (e) {
      msg("测试失败：" + e.message, "warn");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#pxSave")?.addEventListener("click", () => save(($("#pxUrl")?.value || "").trim()));
    $("#pxTest")?.addEventListener("click", test);
    $("#pxClear")?.addEventListener("click", () => {
      if ($("#pxUrl")) $("#pxUrl").value = "";
      save("");
    });
    // 回车即保存，和 AI 页的输入习惯一致
    $("#pxUrl")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(($("#pxUrl")?.value || "").trim()); }
    });
  });

  window.RadarProxy = { reload, save, test, isLoaded: () => loaded };
})();
