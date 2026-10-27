const $ = (s) => document.querySelector(s);
const toastEl = $("#toast");
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (isErr ? " err" : "");
  toastEl.hidden = false;
  clearTimeout(window.__tt);
  window.__tt = setTimeout(() => (toastEl.hidden = true), 4000);
}

$("#toggleToken").onclick = () => {
  const i = $("#token");
  i.type = i.type === "password" ? "text" : "password";
};

$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const token = $("#token").value.trim();
  const btn = $("#submitBtn");
  const hint = $("#hint");
  if (!token) { hint.textContent = "token 不能为空"; hint.className = "auth-hint err"; return; }
  btn.disabled = true;
  btn.textContent = "正在验证…";
  hint.textContent = "";
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    btn.textContent = "验证通过，正在进入…";
    location.href = "/";
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "验证并进入";
    hint.textContent = err.message;
    hint.className = "auth-hint err";
    toast(err.message, true);
  }
};

// 已登录就直接进去
fetch("/api/auth/state").then((r) => r.json()).then((d) => {
  if (d.authed) location.href = "/";
}).catch(() => {});
