#!/usr/bin/env bun
/** 本地 GitHub 缓存服务（零依赖）。优先从 env/DSH_* 动态读取，值永不落盘。 */
const GH = "https://api.github.com";
const cache = new Map(); // url -> {etag, data, at}
const mem = new Map();   // url -> data （无 etag 的短缓存）
const TTL = Number(process.env.CACHE_TTL_MS || 120_000);
const PORT = Number(process.env.GH_CACHE_PORT || 8787);

function pickToken() {
  const keys = Object.keys(process.env).filter((k) => /^DSH_.*(GITHUB|GH_).*(TOKEN|PAT)/i.test(k) || k === "GITHUB_TOKEN" || k === "GH_TOKEN");
  for (const k of keys) if (process.env[k]) return process.env[k];
  return "";
}

async function handler(req) {
  const u = new URL(req.url);
  if (u.pathname === "/__health") {
    return Response.json({ ok: true, token: pickToken() ? "yes" : "no", cached: cache.size, mem: mem.size });
  }
  const target = GH + u.pathname + u.search;
  const headers = { "User-Agent": "gh-cache/1.0", Accept: req.headers.get("accept") || "application/vnd.github+json" };
  const token = pickToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const hit = cache.get(target);
  if (hit?.etag) headers["If-None-Match"] = hit.etag;

  const fresh = mem.get(target);
  if (fresh && Date.now() - fresh.at < TTL) return withMeta(fresh.data, "HIT-MEM");

  let res;
  try {
    // 上游无超时会一直挂着连接，stale fallback 只在抛错时触发，永远等不到
    res = await fetch(target, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    if (hit) return withMeta(hit.data, "STALE", { "x-cache-error": e.message });
    return new Response(JSON.stringify({ message: String(e) }), { status: 502, headers: { "content-type": "application/json" } });
  }
  const out = new Headers({ "content-type": res.headers.get("content-type") || "application/json" });
  for (const k of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "link"]) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  if (res.status === 304 && hit) {
    mem.set(target, { data: hit.data, at: Date.now() });
    return withMeta(hit.data, "REVALIDATED", out);
  }
  let text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (res.ok) {
    const etag = res.headers.get("etag");
    if (etag && typeof data === "object") cache.set(target, { etag, data, at: Date.now() });
    mem.set(target, { data, at: Date.now() });
  }
  out.set("content-type", out.get("content-type") || "application/json");
  return new Response(typeof data === "string" ? data : JSON.stringify(data), { status: res.status, headers: out });
}

function withMeta(data, tag, extra) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "x-cache": tag });
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(JSON.stringify(data), { headers: h });
}

Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: handler });
console.log(`gh-cache on http://127.0.0.1:${PORT} token=${pickToken() ? "yes" : "no"}`);
