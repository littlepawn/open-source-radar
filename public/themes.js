const themes = [
  { id: "t1", name: "深空", desc: "当前版本 · 墨绿主色 + 蓝辅助", note: "最稳，长时间看不累" },
  { id: "t2", name: "石墨", desc: "中性灰 · 近乎无彩色", note: "冷静克制，像 IDE" },
  { id: "t3", name: "午夜蓝", desc: "冷调深蓝 · 蓝紫渐变感", note: "最有科技感" },
  { id: "t4", name: "暖夜", desc: "暖灰棕底 · 琥珀点缀", note: "护眼，适合夜里" },
  { id: "t5", name: "极简纸", desc: "亮色 · 黑白为主", note: "像文档，打印友好" },
  { id: "t6", name: "霓虹终端", desc: "近黑 + 荧光绿 · 等宽字体", note: "极客味最重" },
];
const cardHtml = (t) => `
<div class="mini ${t.id}">
  <aside>
    <div class="logo">◎ 开源雷达</div>
    <div class="ni on"><span>▦ 全部</span><span>150</span></div>
    <div class="ni"><span>★ 我 Star 的</span><span>147</span></div>
    <div class="ni"><span>⑂ 我的 Fork</span><span>3</span></div>
    <div class="chips">
      <span class="chip on">AI / Agent 14</span><span class="chip">数据库 16</span>
      <span class="chip">命令行 14</span><span class="chip">自托管 14</span>
    </div>
    <div class="btn">同步 GitHub</div>
  </aside>
  <div class="main2">
    <div class="search">搜索仓库名 / 描述 / topics…</div>
    <div class="cards2">
      <div class="c"><div class="t">superpowers</div>
        <div class="d">归类：AI / Agent、数据库。技能框架，让 agent 按方法论工作。</div>
        <div class="row"><span class="chip">AI / Agent</span><span class="chip">数据库</span></div>
        <div class="st">★ 306k · Shell</div></div>
      <div class="c"><div class="t">public-apis</div>
        <div class="d">A collective list of free APIs for use in software development.</div>
        <div class="row"><span class="chip">文档办公</span></div>
        <div class="st">★ 492k · Python</div></div>
    </div>
  </div>
</div>`;

document.getElementById("grid").innerHTML = themes.map((t, i) => `
  <section class="pick" data-id="${t.id}">
    <header><b>${i + 1}. ${t.name}</b><span>${t.desc}</span><em>${t.note}</em></header>
    <div class="pane">${cardHtml(t)}</div>
    <div class="acts">
      <button data-pick="${t.id}">用这套</button>
      <span class="tag">${t.id}</span>
    </div>
  </section>`).join("") + `
  <section class="pick mixnote">
    <b>也可以混搭</b>
    <div class="mixbody">
      · 配色选一套，字体/圆角可以另外指定<br>
      · 想要「亮色 + 荧光绿」或「深空 + 琥珀」这类组合，也可以直接说<br>
      · 登录页会随主题一起变
    </div>
  </section>`;

// 选中态只有一个真源 selectedId，class / 按钮文案 / cur 徽标全部由它派生，
// 否则换选后旧的按钮会留着「已选 · tX」而页面同时显示两个选中。
const THEME_IDS = new Set(themes.map((t) => t.id));
function syncSelection() {
  const fromHash = (location.hash || "").replace(/^#/, "");
  const selectedId = THEME_IDS.has(fromHash) ? fromHash : "t1";
  document.querySelectorAll(".pick[data-id]").forEach((sec) => {
    const on = sec.dataset.id === selectedId;
    sec.classList.toggle("cur", on);
    const b = sec.querySelector("[data-pick]");
    if (b) {
      b.classList.toggle("pick1", on);
      b.textContent = on ? "已选 · " + sec.dataset.id : "用这套";
    }
  });
  return selectedId;
}
document.querySelectorAll("[data-pick]").forEach((b) => {
  b.onclick = () => { location.hash = b.dataset.pick; syncSelection(); };
});
window.addEventListener("hashchange", syncSelection);
syncSelection();
