#!/usr/bin/env bun
/**
 * 开源雷达 · GitHub 收藏本地看板
 * 零第三方依赖，只用 Bun 内置 (Bun.serve / fetch / node:fs)。
 *
 * 启动：  ~/.bun/bin/bun server.mjs            # 默认 127.0.0.1:8788
 * 可选环境变量：
 *   PORT=8788
 *   HOST=127.0.0.1
 *   DATA_DIR=./data
 *   RADAR_DB=/data/radar.db
 *   SESSION_SECRET=...        # 可选；不设则由 db 里自动生成并持久化
 *
 * 鉴权：首次访问进入登录页，必须填写有效 GitHub token 才能进入。
 *   token 校验通过后写入 SQLite（AES-GCM 加密，密钥派生自 SESSION_SECRET），
 *   并以 HttpOnly Cookie 维持会话。环境变量 GITHUB_TOKEN 存在时作为兜底。
 *   数据目录下若无有效 token，接口一律 401。
 */
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, extname, normalize as pnorm } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ruleDigest } from "./lib/rules.mjs";
import { readRate, mergeRate, rateFor, rateText } from "./lib/ratelimit.mjs";
import {
  pickKeyFiles, buildMessages, validateAiConfig, resolveBaseUrl, normalizeModels,
  matchProvider, AI_PRESETS, DEFAULT_EXTRA_PROMPT,
} from "./lib/ai.mjs";
// 查询参数统一收敛：NaN / 越界都回落到默认，不让脏输入进 SQL 或纯函数
function clampNum(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

import { stagnation, cleanupCandidates, forkLag, forkLagText, similarTo } from "./lib/insight.mjs";
import { DISCOVER_DEFAULTS, DISCOVER_NOTE, buildDiscoverQuery } from "./lib/discover.mjs";
import {
  clampInterval, msUntilNext, humanInterval,
  DEFAULT_INTERVAL_MIN, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN,
  autoSyncRuntime as libAutoSyncRuntime,
} from "./lib/schedule.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "127.0.0.1";
// RADAR_DB 可指定完整 db 文件路径（测试用），DATA_DIR 可指定目录，默认 ./data/radar.db
const DATA_DIR = process.env.RADAR_DB ? dirname(process.env.RADAR_DB) : (process.env.DATA_DIR || join(ROOT, "data"));
const DB_FILE = process.env.RADAR_DB || join(DATA_DIR, "radar.db");
const PUBLIC_DIR = join(ROOT, "public");
const ENV_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
// 可用 RADAR_GH 指向 mock 服务做端到端测试，默认官方 API
const GH = process.env.RADAR_GH || "https://api.github.com";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------- 数据库 */
// 启动即自检：打不开就明确报错退出，不要带着坏库跑（否则错误会在同步时才以
// 「配额用尽」之类的假象暴露出来）。目录被外部删掉时 WAL 也会锁死。
let db;
try {
  db = new Database(DB_FILE, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.query("SELECT 1").get();
} catch (e) {
  console.error(`[fatal] 数据库打不开：${DB_FILE}\n        ${e.message}`);
  console.error(`        检查目录是否存在、进程是否有写权限；若为测试实例先用 RADAR_DB 指向可写路径。`);
  process.exit(1);
}
db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY,          -- github repo id
  full_name     TEXT NOT NULL,
  owner         TEXT,
  name          TEXT,
  html_url      TEXT,
  description   TEXT,
  homepage      TEXT,
  language      TEXT,
  topics        TEXT,       -- JSON array
  stars         INTEGER DEFAULT 0,
  forks         INTEGER DEFAULT 0,
  issues        INTEGER DEFAULT 0,
  watchers      INTEGER DEFAULT 0,
  size_kb       INTEGER DEFAULT 0,
  license       TEXT,
  archived      INTEGER DEFAULT 0,
  is_fork       INTEGER DEFAULT 0,
  created_at    TEXT,
  pushed_at     TEXT,
  starred_at    TEXT,
  source        TEXT,       -- 'starred' | 'fork'
  upstream      TEXT,       -- fork 的上游 full_name
  readme        TEXT,       -- markdown，懒加载
  digest        TEXT,       -- 中文简介（规则或 AI 生成）
  digest_src    TEXT,       -- 'rule' | 'ai' | 'manual'
  fetched_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_repos_source ON repos(source);
CREATE INDEX IF NOT EXISTS idx_repos_stars  ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_repos_pushed ON repos(pushed_at DESC);
`);
// 轻量迁移：老库补列。SQLite 的 ADD COLUMN 不能带 NOT NULL 无默认值，全部给默认。
function addColumn(table, col, ddl) {
  const cols = db.query(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn("repos", "upstream", "upstream TEXT");
addColumn("repos", "note", "note TEXT");                       // 手写备注，独立于 digest
addColumn("repos", "toread", "toread INTEGER DEFAULT 0");      // 待读队列
addColumn("repos", "opened_at", "opened_at TEXT");             // 首次打开详情的时间
addColumn("repos", "open_count", "open_count INTEGER DEFAULT 0"); // 打开次数，清理建议要用
addColumn("repos", "dropped", "dropped INTEGER DEFAULT 0");    // 放弃标记（与 hidden 不同，不动 star）
addColumn("repos", "dropped_at", "dropped_at TEXT");
addColumn("repos", "fork_behind", "fork_behind INTEGER");      // fork 落后上游 commit 数，null=未比对
addColumn("repos", "fork_ahead", "fork_ahead INTEGER");
addColumn("repos", "fork_checked_at", "fork_checked_at TEXT");
addColumn("repos", "branch", "branch TEXT");
addColumn("repos", "last_seen_at", "last_seen_at TEXT");   // 本轮同步里最后一次被上游列到的时间
addColumn("repos", "detached", "detached INTEGER DEFAULT 0"); // 上游已无此 star/fork（远端取消或仓库删了）
addColumn("repos", "detached_at", "detached_at TEXT");     // 首次发现它消失的时间
db.exec(`CREATE INDEX IF NOT EXISTS idx_repos_dropped ON repos(dropped);`);
addColumn("repos", "ai_summary", "ai_summary TEXT");
db.exec(`

CREATE TABLE IF NOT EXISTS tags (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT UNIQUE NOT NULL,
  color  TEXT,
  kind   TEXT DEFAULT 'manual',   -- manual | auto | ai
  sort   INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS repo_tags (
  repo_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  source  TEXT DEFAULT 'manual',  -- manual | auto | ai
  PRIMARY KEY (repo_id, tag_id)
);
CREATE TABLE IF NOT EXISTS hidden (
  repo_id INTEGER PRIMARY KEY,
  at      TEXT
);
CREATE TABLE IF NOT EXISTS releases (
  repo_id     INTEGER NOT NULL,
  tag         TEXT,
  name        TEXT,
  published_at TEXT,
  url         TEXT,
  checked_at  TEXT,
  PRIMARY KEY (repo_id)
);
CREATE TABLE IF NOT EXISTS events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    TEXT,
  level TEXT,
  msg   TEXT
);
`);
// 标签两级分组：parent 为空表示顶层。必须在建表之后调用，否则 PRAGMA 查不到表，
// addColumn 会以为列不存在而去 ALTER 一张不存在的表（或被 IF NOT EXISTS 静默吞掉）。
addColumn("tags", "parent", "parent TEXT");

const now = () => new Date().toISOString();
function log(level, msg) {
  try {
    db.query("INSERT INTO events (at, level, msg) VALUES (?,?,?)").run(now(), level, String(msg).slice(0, 2000));
  } catch {}
  console.log(`[${level}] ${msg}`);
}
const getMeta = (k, d = null) => {
  const r = db.query("SELECT v FROM meta WHERE k=?").get(k);
  return r ? r.v : d;
};
const LOGIN = () => process.env.RADAR_LOGIN || getMeta("login") || "";
const setMeta = (k, v) =>
  db.query("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v));

/* ---------------------------------------------------------------- 鉴权 */
// 会话密钥：优先环境变量；否则首次启动生成并持久化到 db（data 卷里，容器重建不失效）
const SECRET = (process.env.SESSION_SECRET || "").trim();

// token 加密：AES-256-GCM，密钥由 SESSION_SECRET（或自动生成的库内密钥）派生。
// 库内密钥存在 auth 表 k='secret'，不是 meta 表——曾写成 getMeta("auth_secret")，
// 读不到就静默退化成固定字符串 "radar:null"，等于没加密。
const authSecret = () => db.query("SELECT v FROM auth WHERE k='secret'").get()?.v || "";
function deriveKey() {
  const base = SECRET || authSecret();
  if (!base) {
    console.error("[fatal] 缺少加密密钥（SESSION_SECRET 与 auth.secret 均为空），拒绝启动");
    process.exit(1);
  }
  return createHash("sha256").update("radar:" + base).digest();
}
function encToken(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), enc]));
}
function decToken(blob) {
  return decTokenWith(blob, deriveKey());
}
function decTokenWith(blob, key) {
  try {
    const raw = unb64u(blob);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

initAuthTables();
const SESSION_COOKIE = "radar_sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // 30 天

function b64u(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(str) {
  return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// 会话表
function initAuthTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      k TEXT PRIMARY KEY,
      v TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      login   TEXT,
      at      INTEGER,
      exp     INTEGER
    );
  `);
  // 自动生成并持久化密钥（仅当没设 SESSION_SECRET）
  const has = db.query("SELECT v FROM auth WHERE k='secret'").get();
  if (!has) db.query("INSERT INTO auth (k,v) VALUES ('secret',?)").run(randomBytes(32).toString("hex"));
  migrateLegacyToken();
}

// 密钥来源曾写错（读 meta 表读不到），旧密文实际用固定密钥 "radar:null" 加密。
// 修好来源后旧密文解不开，这里做一次性迁移：旧密钥解密 → 新密钥重加密。
function migrateLegacyToken() {
  const row = db.query("SELECT v FROM auth WHERE k='token'").get();
  if (!row) return;
  if (decTokenWith(row.v, deriveKey())) return;   // 新密钥能解，无需迁移
  const legacyBase = "null";
  const legacyKey = createHash("sha256").update("radar:" + legacyBase).digest();
  const plain = decTokenWith(row.v, legacyKey);
  if (!plain) {
    log("warn", "已存 token 无法用新旧任一密钥解密，需重新登录");
    db.query("DELETE FROM auth WHERE k='token'").run();
    return;
  }
  db.query("UPDATE auth SET v=? WHERE k='token'").run(encToken(plain));
  log("info", "已用新密钥重新加密已存 token");
}

let runtimeToken = "";     // 解密后的 token，进程内存里常驻
function loadStoredToken() {
  const row = db.query("SELECT v FROM auth WHERE k='token'").get();
  if (!row) return "";
  return decToken(row.v);
}
function storeToken(token, login) {
  db.query("INSERT INTO auth (k,v) VALUES ('token',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(encToken(token));
  if (login) db.query("INSERT INTO auth (k,v) VALUES ('login',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(login);
}
function clearStoredToken() {
  db.query("DELETE FROM auth WHERE k IN ('token','login')").run();
  db.query("DELETE FROM sessions").run();
  runtimeToken = "";
}

// 当前生效 token：环境变量 > 登录时保存的
function currentToken() {
  return ENV_TOKEN || runtimeToken || "";
}

/* ---------------------------------------------------------------- AI 配置
   key 存在 auth 表（与 GitHub token 同一套 AES-256-GCM），meta 表只存不含密钥的字段。
   读取时 key 永远只回 "已配置/未配置"，绝不落到 HTTP 响应里。            */
const AI_DEFAULTS = {
  enabled: false,
  base_url: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  max_tokens: 2000,
  temperature: 0.2,
  // 默认就带一套「GitHub 项目分析专家」的方法论，用户不必自己想怎么问。
  // 存的是默认值本身而不是空串：否则设置页显示空文本框，用户以为没配置。
  extra_prompt: DEFAULT_EXTRA_PROMPT,
};
function getAiConfig() {
  const cfg = { ...AI_DEFAULTS };
  for (const k of Object.keys(AI_DEFAULTS)) {
    const v = getMeta(`ai_${k}`);
    if (v === null || v === undefined) continue;
    if (typeof AI_DEFAULTS[k] === "number") cfg[k] = Number(v);
    else if (typeof AI_DEFAULTS[k] === "boolean") cfg[k] = v === "true" || v === "1";
    else cfg[k] = v;
  }
  cfg.has_key = !!db.query("SELECT v FROM auth WHERE k='ai_key'").get();
  return cfg;
}
function setAiKey(plain) {
  const s = String(plain || "").trim();
  if (!s) return db.query("DELETE FROM auth WHERE k='ai_key'").run();
  db.query("INSERT INTO auth (k,v) VALUES ('ai_key',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(encToken(s));
}
function aiKey() {
  const row = db.query("SELECT v FROM auth WHERE k='ai_key'").get();
  return row ? decToken(row.v) : "";
}

// 单仓对话上下文缓存：同一个仓库同一份 README 不必每次重拉文件树。
// 只放进程内存，重启即失效（README 会变，长期缓存反而会答错）。
const aiCtxCache = new Map();   // repo_id -> { readme, tree, files, at }
const AI_CTX_TTL_MS = 10 * 60 * 1000;

async function aiRepoContext(row, { wantTree = true } = {}) {
  const hit = aiCtxCache.get(row.id);
  if (hit && Date.now() - hit.at < AI_CTX_TTL_MS) return hit;
  const readme = await fetchReadme(row).catch(() => "");
  let tree = [];
  let files = {};
  if (wantTree && currentToken()) {
    try {
      const repo = await gh(`/repos/${row.full_name}`);
      const branch = repo?.default_branch || "main";
      const t = await gh(`/repos/${row.full_name}/git/trees/${branch}?recursive=1`);
      tree = (t?.tree || []).filter((x) => x.type === "blob").map((x) => x.path);
      for (const f of pickKeyFiles(tree, 6)) {
        const blob = await gh(`/repos/${row.full_name}/contents/${encodeURIComponent(f)}?ref=${branch}`, { accept: "application/vnd.github.raw" });
        if (typeof blob === "string") files[f] = blob;
      }
    } catch (e) {
      log("warn", `拉取 ${row.full_name} 结构失败：${e.message}`);
    }
  }
  const ctx = { readme, tree, files, at: Date.now() };
  aiCtxCache.set(row.id, ctx);
  return ctx;
}

// URL 里可能带 key（https://x/v1?key=sk-...）或 userinfo，落日志前剥掉
function safeUrlForLog(u) {
  try { const x = new URL(String(u)); return x.origin + x.pathname; } catch { return "(invalid)"; }
}
// 上游错误体 / 配置值里可能出现的凭据，落库与下发前一律打码
function redactSecrets(s) {
  return String(s ?? "").replace(/(sk-|Bearer\s+|gh[pousr]_|github_pat_|api[_-]?key["'=:\s]*)[A-Za-z0-9_\-]{8,}/gi, "$1***");
}

// OpenAI 兼容的 chat/completions，一套配置覆盖 DeepSeek / 通义 / Kimi / Ollama / oneAPI
async function aiChat(messages, cfg) {
  const key = aiKey();
  if (!key) throw new Error("未配置 AI API Key（在「AI 设置」里填）");
  const url = `${resolveBaseUrl(cfg.base_url)}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: Number(cfg.max_tokens) || 2000,
      temperature: Number(cfg.temperature) ?? 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) {
    // 中转站常把真实原因塞在 body 里，别只报状态码
    // 错误体是上游给的，可能回显我们发出的 Authorization（中转站常见 sk-...abcd）。
    // 这条消息会 log 进 events 表并随 recent_events 下发前端，必须先脱敏再往下传。
    let msg = redactSecrets(text.slice(0, 400));
    try { const j = JSON.parse(text); msg = redactSecrets(String(j.error?.message || j.message || msg)); } catch {}
    throw new Error(`AI 接口 ${res.status}：${msg}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("AI 接口返回的不是 JSON"); }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 返回空内容");
  return { content, usage: data.usage || null, model: data.model || cfg.model };
}

function parseCookies(req) {
  const h = req.headers.get("cookie") || "";
  const out = {};
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function newSession(login) {
  // 会话只增不删：sessionInfo 只在「这个 sid 又被访问到且已过期」时才删，
  // 再也没人带着它访问的过期 sid 会永久留在表里，TTL 形同虚设。
  // 顺手把同一用户此前登录留下的旧 sid 清掉——否则每次登录都多一条有效会话。
  db.query("DELETE FROM sessions WHERE exp < ? OR login = ?").run(Date.now(), login);
  const sid = randomBytes(24).toString("hex");
  const at = Date.now();
  db.query("INSERT INTO sessions (sid,login,at,exp) VALUES (?,?,?,?)").run(sid, login, at, at + SESSION_TTL_MS);
  return sid;
}
function sidFromReq(req) {
  return parseCookies(req)[SESSION_COOKIE] || "";
}
function sessionInfo(req) {
  const sid = sidFromReq(req);
  if (!sid) return null;
  const row = db.query("SELECT * FROM sessions WHERE sid=?").get(sid);
  if (!row) return null;
  // 必须防 NaN：exp 缺失时 Number(null)=0 尚可，但脏数据会算出 NaN，
  // 而 NaN < Date.now() 恒为 false —— 过期会话反而永远有效。
  const exp = Number(row.exp);
  if (!Number.isFinite(exp) || exp < Date.now()) {
    db.query("DELETE FROM sessions WHERE sid=?").run(sid);
    return null;
  }
  return row;
}
function requireAuth(req) {
  // 有环境变量 token 时视为始终已登录（单用户自托管场景），但仍需会话避免裸奔
  const s = sessionInfo(req);
  if (s) return s;
  return null;
}
function isAuthed(req) {
  if (sessionInfo(req)) return true;
  return false;
}

// 启动时把库里加密保存的 token 解出来常驻内存
runtimeToken = loadStoredToken();

// 顺手清掉过期会话。sessionInfo 只在「某个 sid 又被带着访问且已过期」时才删它，
// 再没人用的过期 sid 会永久留在表里，TTL 形同虚设。
db.query("DELETE FROM sessions WHERE exp < ?").run(Date.now());


/* ---------------------------------------------------------------- GitHub 客户端 */
// 配额按资源分桶（core 5000/h、search 30/min …）。曾经是一个全局变量存「最后一次响应的头」，
// 于是搜索后跑一次同步，界面就在「搜索配额」处显示 core 的 5000——见 lib/ratelimit.mjs 注释。
let rates = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(path, { retry = 3, accept } = {}) {
  const url = path.startsWith("http") ? path : GH + path;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const headers = {
      "User-Agent": "open-source-radar/1.0",
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const tk = currentToken();
    if (tk) headers.Authorization = `Bearer ${tk}`;
    let res;
    try {
      // 没有超时会一直挂到 undici 的 300s 默认值，前端只看到 "fetch failed"。
      // GitHub 单次响应极少超过 15s，超时就当网络错误重试。
      res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      const why = e.name === "TimeoutError" ? "15s 超时" : e.message;
      if (attempt === retry) throw new Error(`网络错误 ${url}: ${why}（已重试 ${retry} 次）`);
      await sleep(800 * (attempt + 1));
      continue;
    }
    const rl = (n) => res.headers.get(`x-ratelimit-${n}`);
    rates = mergeRate(rates, readRate(res.headers));
    if (res.status === 304) return { notModified: true };
    if (res.ok) {
      const remaining = Number(rl("remaining") ?? 1);
      const isSearch = url.includes("/search/");
      // 用 search 桶自己的 reset，不能拿全局值——core 的 reset 在一小时后，
      // 拿它算等待会让「搜索配额仅剩 1」时白等一小时。
      const searchBucket = rateFor(rates, "search");
      // 配额将尽时要在「下次请求」前等，而不是扔掉这次已经成功拿到的响应再重发：
      // 搜索结果是分页的，重发会得到不同 offset 的内容，丢页比等待更糟。
      const data = await res.json();
      if (remaining <= 2 && searchBucket?.reset && isSearch) {
        const wait = Math.max(0, searchBucket.reset - Date.now());
        if (wait > 0 && wait < 15 * 60 * 1000) {
          log("warn", `搜索配额仅剩 ${remaining}，本次结果已保留，等待 ${Math.round(wait / 1000)}s 后再请求`);
          await sleep(wait + 300);
        }
      }
      return data;
    }
    if (res.status === 403 || res.status === 429) {
      // 403 不都是限流：GitHub 会用同一个状态码表示
      //   · 仓库被 TOS 封禁（"Repository access blocked" + reason:"tos"）
      //   · 无权限 / token 缺 scope（"Resource not accessible by integration"）
      //   · 二级限流（"You have exceeded a secondary rate limit"）
      // 只有最后一种值得等待重试。把永久拒绝当成限流会白等 3×900s 并把
      // 界面谎报成「配额用尽」——2022 被封的 littlepawn/GLaDOS-CheckIn 就踩过。
      const bodyText = await res.text().catch(() => "");
      const rlRemain = Number(res.headers.get("x-ratelimit-remaining") ?? -1);
      const isSecondary = /secondary rate limit|abuse detection/i.test(bodyText);
      const isRateLimited = res.status === 429 || isSecondary || rlRemain === 0;
      if (!isRateLimited) {
        const blocked = /repository access blocked/i.test(bodyText);
        const reason = (bodyText.match(/"reason"\s*:\s*"([^"]+)"/) || [])[1];
        const kind = blocked ? `仓库被 GitHub 封禁${reason ? `（reason: ${reason}）` : ""}` : `拒绝访问（可能是 token 无权限）`;
        log("warn", `${kind}：${url}`);
        return { forbidden: true, status: res.status, message: `${kind}：${bodyText.slice(0, 160)}` };
      }
      // 限流等待用「当前请求所属资源」的 reset，取不到再退到 core，最后退到 60s。
      const bucket = rateFor(rates, res.headers.get("x-ratelimit-resource") || "core") || rateFor(rates, "core");
      const wait = bucket?.reset ? Math.max(1000, bucket.reset - Date.now()) : 60000;
      const retryAfter = Number(res.headers.get("retry-after") || 0) * 1000;
      const delay = retryAfter || Math.min(wait + 500, 15 * 60 * 1000);
      if (attempt === retry) {
        throw new Error(`GitHub 限速 ${res.status} ${url} ${bodyText.slice(0, 200)}`);
      }
      if (!currentToken() && attempt === 0) {
        const mins = Math.max(1, Math.ceil((delay + 1000) / 60000));
        throw new Error(
          `GitHub ${res.status} 限速（匿名 60 次/小时，已用尽，约 ${mins} 分钟后恢复）。` +
          `建议配 GITHUB_TOKEN=ghp_xxx 后重启，配额变 5000 次/小时。原始返回：${bodyText.slice(0, 120)}`
        );
      }
      log("warn", `GitHub ${res.status} 限速 ${url}，等待 ${Math.round(delay / 1000)}s 重试 (${attempt + 1}/${retry})`);
      syncState.phase = `触发限流，等待 ${Math.round(delay / 1000)}s 后重试（${attempt + 1}/${retry}）`;
      syncState.retry_at = Date.now() + delay;
      broadcast({ type: "progress", ...syncState });
      await sleep(delay);
      syncState.retry_at = null;
      continue;
    }
    if (res.status === 404) return { notFound: true };
    const body = await res.text().catch(() => "");
    if (attempt === retry) throw new Error(`GitHub ${res.status} ${url} ${body.slice(0, 200)}`);
    await sleep(500 * (attempt + 1));
  }
  throw new Error(`GitHub 请求失败 ${url}`);
}

function parseLink(h) { return h || ""; }

async function paged(path, onPage, { maxPages = 50, perPage = 100, accept } = {}) {
  let page = 1;
  let total = 0;
  while (page <= maxPages) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await gh(`${path}${sep}per_page=${perPage}&page=${page}`, { accept });
    if (data.notFound) throw new Error(`路径不存在：${path}`);
    if (!Array.isArray(data)) throw new Error(`非预期返回：${path}`);
    if (data.length === 0) break;
    // star+json 返回 {starred_at, repo}；repo 为 null 表示该仓库已删除/转私有/无权限。
    // 绝不能把包装对象当 repo 写入（会撞 repos.full_name NOT NULL 并中断整轮同步）。
    let skipped = 0;
    const items = [];
    for (const x of data) {
      if (!x) { skipped++; continue; }
      const repo = x.repo !== undefined ? x.repo : x;
      if (!repo || !repo.full_name || !repo.id) { skipped++; continue; }
      items.push(x.repo !== undefined ? { ...repo, starred_at: x.starred_at || null } : repo);
    }
    if (skipped) log("warn", `第 ${page} 页有 ${skipped} 条无有效仓库（已删除/转私有），已跳过`);
    total += items.length;
    await onPage(items, page);
    setMeta("last_progress", JSON.stringify({ path, page, total, at: now() }));
    if (data.length < perPage) break;
    page++;
    await sleep(120);
  }
  return total;
}

/* ---------------------------------------------------------------- 中文简介规则引擎 */
// 规则表与 ruleDigest 抽到 lib/rules.mjs（纯函数，可被 bun test 直接 import）。
// 三份规则表的同步约束见 AGENTS.md。现在唯一权威是 lib/rules.mjs：
//   - public/rules.js 由 scripts/gen-rules.mjs 从它生成（前端预览用同一份）
//   - scripts/rules.json 同样由该脚本产出（import_mcp_cache.py 读它）
//   - tests/rules-sync.test.mjs 断言三处没有漂移，改规则忘同步会直接红。
// 这里曾经还留着一份 fmt（没有调用点，且缺 1e6→M 分档与 Number.isFinite 兜底），
// 删掉：需要格式化星数就 import { fmt } from "./lib/rules.mjs"。

/* ---------------------------------------------------------------- 入库 */
// 注意：branch 用 COALESCE(NULLIF(...)) —— 同步这趟可能没带 default_branch
// （部分接口裁剪过字段），空值不能把上次记下的分支冲掉，否则 fork 对比会退回猜 "main"。
const upsertRepo = db.prepare(`
INSERT INTO repos (id, full_name, owner, name, html_url, description, homepage, language, topics,
  stars, forks, issues, watchers, size_kb, license, archived, is_fork, created_at, pushed_at,
  starred_at, source, branch, fetched_at, last_seen_at)
VALUES ($id,$full_name,$owner,$name,$html_url,$description,$homepage,$language,$topics,
  $stars,$forks,$issues,$watchers,$size_kb,$license,$archived,$is_fork,$created_at,$pushed_at,
  $starred_at,$source,$branch,$fetched_at,$last_seen_at)
ON CONFLICT(id) DO UPDATE SET
  full_name=excluded.full_name, owner=excluded.owner, name=excluded.name,
  html_url=excluded.html_url, description=excluded.description, homepage=excluded.homepage,
  language=excluded.language, topics=excluded.topics, stars=excluded.stars, forks=excluded.forks,
  issues=excluded.issues, watchers=excluded.watchers, size_kb=excluded.size_kb,
  license=excluded.license, archived=excluded.archived, is_fork=excluded.is_fork,
  created_at=excluded.created_at, pushed_at=excluded.pushed_at,
  starred_at=COALESCE(excluded.starred_at, repos.starred_at),
  source=excluded.source, fetched_at=excluded.fetched_at, last_seen_at=excluded.last_seen_at,
  branch=COALESCE(NULLIF(excluded.branch,''), repos.branch),
  -- 上游又列到它了，说明没取消：撤销 detached。不加这行的话，重新 star 的仓库
  -- 会一直躺在「已取消」里不出来。
  detached=0, detached_at=NULL
`);

const tagByName = (name) => {
  let t = db.query("SELECT * FROM tags WHERE name=?").get(name);
  if (!t) {
    db.query("INSERT INTO tags (name, kind) VALUES (?, 'auto')").run(name);
    t = db.query("SELECT * FROM tags WHERE name=?").get(name);
  }
  return t;
};
const addRepoTag = db.prepare(
  "INSERT OR IGNORE INTO repo_tags (repo_id, tag_id, source) VALUES (?,?,?)"
);

function normalize(r, source, starredAt) {
  return {
    id: r.id,
    full_name: r.full_name,
    owner: r.owner?.login || String(r.full_name).split("/")[0] || "",
    name: r.name,
    html_url: r.html_url,
    description: r.description || "",
    homepage: r.homepage || "",
    language: r.language || "",
    topics: JSON.stringify(r.topics || []),
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    issues: r.open_issues_count || 0,
    watchers: r.subscribers_count || r.watchers_count || 0,
    size_kb: r.size || 0,
    license: r.license?.spdx_id || r.license?.key || "",
    archived: r.archived ? 1 : 0,
    is_fork: r.fork ? 1 : 0,
    created_at: r.created_at || "",
    pushed_at: r.pushed_at || "",
    starred_at: starredAt || null,
    source,
    // 默认分支：fork 对比的 compare 两端都要写 owner:branch，缺它就比不了。
    // 这里顺手落库，避免每个 fork 再单独打一次 /repos/:full_name。
    branch: r.default_branch || "",
    fetched_at: now(),
    last_seen_at: now(),
  };
}

function saveRepo(raw, source, starredAt) {
  // 兜底：full_name/id 缺失的条目（已删除、转私有、接口异常）不写库
  if (!raw || !raw.id || !raw.full_name) return null;
  const row = normalize(raw, source, starredAt);
  // bun:sqlite 命名参数：占位符 $x 对应的绑定键必须也带 $ 前缀（普通键绑不上 → NOT NULL 报错）
  const bound = {};
  for (const [k, v] of Object.entries(row)) bound[`$${k}`] = v;
  upsertRepo.run(bound);
  return row;
}

function applyAutoTags(row) {
  const raw = { ...row, topics: JSON.parse(row.topics || "[]") };
  const { digest, tags } = ruleDigest(raw);
  const existing = db.query("SELECT digest_src FROM repos WHERE id=?").get(row.id);
  // 只覆盖 rule 来源（或还没生成过）的简介。AI 生成的内容不能被规则文本替换后
  // 还挂着 digest_src='ai' 的标签——那等于谎报来源，用户的 AI 摘要也会莫名消失。
  // 新收编的行 digest_src 是 NULL（upsertRepo 不写这一列），必须和"根本没这行"一样处理，
  // 否则发现页收编进来的仓库永远没有自动简介（实测 openclaw digest=null）。
  if (!existing || !existing.digest_src || existing.digest_src === "rule") {
    db.query("UPDATE repos SET digest=?, digest_src='rule' WHERE id=?").run(digest, row.id);
  }
  return tags;
}

/* ---------------------------------------------------------------- 同步：stars + forks */
let syncState = { running: false, kind: null, total: 0, done: 0, started_at: null, error: null, phase: "" };

/* 自动同步调度。用 setTimeout 链而不是 setInterval：
   间隔可随时改，setInterval 改了得重开，且同步耗时长于间隔时会堆叠。
   每次跑完按「上次成功时间 + 间隔」重算下一次，错过就立刻补——见 lib/schedule.mjs。 */
let autoSyncTimer = null;
function autoSyncConfig() {
  return {
    enabled: getMeta("auto_sync_enabled") !== "false",       // 默认开
    interval: clampInterval(getMeta("auto_sync_interval") || DEFAULT_INTERVAL_MIN),
  };
}
/* 自动同步的「运行时」信息：算法在 lib/schedule.mjs 里（有单测），
   这里只负责把 meta 表的值喂进去。 */
function autoSyncRuntime(interval) {
  return {
    default_interval: DEFAULT_INTERVAL_MIN,
    min_interval: MIN_INTERVAL_MIN,
    max_interval: MAX_INTERVAL_MIN,
    ...libAutoSyncRuntime({
      ok: getMeta("last_sync_ok"),
      attempt: getMeta("last_sync_attempt"),
      error: getMeta("last_sync_error"),
      interval,
    }),
  };
}
function scheduleAutoSync() {
  if (autoSyncTimer) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
  const { enabled, interval } = autoSyncConfig();
  if (!enabled) return;
  // 定基准时间：成功过就用成功时间；一次没成功过（或上次是失败）就看上次尝试时间。
  // 都把失败算进基准，才不会出现「失败 → last_sync_ok 还是空 → 立刻重试」的忙循环。
  const { next_run_at } = autoSyncRuntime(interval);
  const wait = (next_run_at ?? Date.now()) - Date.now();
  // 至少 5s，避免「立刻要跑」时把定时器打成忙循环
  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null;
    if (syncState.running) { scheduleAutoSync(); return; }   // 手动同步正跑着，等下一轮
    log("info", `自动同步触发（间隔 ${humanInterval(interval)}）`);
    await runSync("all");
    scheduleAutoSync();
  }, Math.max(5000, wait));
  if (autoSyncTimer.unref) autoSyncTimer.unref();            // 别拦住进程退出
}

const listeners = new Set();
function broadcast(obj) {
  db.query("DELETE FROM events WHERE id <= (SELECT MAX(id)-2000 FROM events)").run();
  for (const fn of listeners) {
    // 吞掉单个监听器的异常，别让一个坏流打断整轮广播
    try { fn(obj); } catch {}
  }
}
db.query("DELETE FROM events WHERE id <= (SELECT MAX(id)-2000 FROM events)").run();

class StopPaging extends Error {}

async function syncStarred({ incremental = true } = {}) {
  const seen = new Set();
  syncState.phase = "拉取 starred";
  // 匿名环境 /user/* 会 401；实测匿名可读 /users/:login/starred，且支持 star+json 取 starred_at
  let endpoint = "/user/starred";
  let accept = "application/vnd.github.star+json";
  if (!currentToken()) {
    const login = LOGIN();
    if (!login) throw new Error("未配置 GITHUB_TOKEN，且不知道要读谁的收藏：请设 RADAR_LOGIN=你的用户名，或配 token");
    endpoint = `/users/${login}/starred`;
    log("info", `未配置 token，匿名读取 ${login} 的公开收藏（60 次/小时，只能拿到最近的）`);
  }
  const last = getMeta("stars_last_oldest");  // 上次同步抓到的最早收藏时间
  let count = 0;
  let oldest = null;
  let stop = false;
  await paged(endpoint, async (items) => {
    for (const r of items) {
      try {
        if (r.starred_at && (oldest === null || r.starred_at < oldest)) oldest = r.starred_at;
        const row = saveRepo(r, "starred", r.starred_at || null);
        if (!row) { syncState.skipped = (syncState.skipped || 0) + 1; continue; }
        seen.add(row.id);
        const tags = applyAutoTags(row);
        for (const t of tags) addRepoTag.run(row.id, tagByName(t).id, "auto");
        count++;
        syncState.done = count;
        if (count % 20 === 0) broadcast({ type: "progress", ...syncState });
      } catch (e) {
        syncState.skipped = (syncState.skipped || 0) + 1;
        log("warn", `跳过 ${r?.full_name || r?.id || "未知条目"}：${e.message}`);
      }
    }
    broadcast({ type: "progress", ...syncState, total: count });
    if (incremental && last && oldest && oldest <= last && count > 100) {
      stop = true;
      throw new StopPaging();
    }
  }, { maxPages: 500, accept }).catch((e) => {
    if (!(e instanceof StopPaging)) throw e;
  });
  setMeta("stars_last_oldest", oldest || last || "");
  if (stop) log("info", `增量同步：已追平上次同步边界（${String(last).slice(0, 10)}），停止翻页`);
  // full=false 表示这趟没翻到底（增量提前刹车）。判「谁消失了」必须在翻到底的前提下做，
  // 否则后面那些根本没扫到的仓库会被当成「上游没了」，整库误标。
  return { count, seen, full: !stop, oldest };
}
async function syncForks() {
  const seen = new Set();
  syncState.phase = "拉取 fork";
  const me = await gh("/user");
  if (me.notFound) throw new Error("无法读取 /user，token 是否有效？");
  const login = me.login;
  const data = await gh(`/users/${login}/repos?type=owner&affiliation=owner&per_page=100&sort=updated`);
  if (!Array.isArray(data)) throw new Error("读取自己的仓库失败");
  let forks = data.filter((r) => r.fork);
  let page = 2;
  // 分页补全。原写法 while (data.length === 100 || forks.length) 里的 data 是第一页的，
  // 永不更新 → 条件退化成 while(true)，只靠 page>20 兜底，语义不明。这里显式记 full。
  let full = data.length < 100;
  while (!full) {
    if (page > 20) { log("warn", "fork 超过 20 页，本次没翻完，跳过「已取消」判定"); break; }
    const more = await gh(`/users/${login}/repos?type=owner&per_page=100&sort=updated&page=${page}`);
    if (!Array.isArray(more) || more.length === 0) { full = true; break; }
    forks = forks.concat(more.filter((r) => r.fork));
    if (more.length < 100) { full = true; break; }
    page++;
  }
  // fork 上游：列表接口不返回 parent（实测 25 个 fork 全无该字段），按需单独查详情
  let count = 0;
  for (const r of forks) {
    let row;
    try {
      row = saveRepo(r, "fork", null);
    } catch (e) {
      log("warn", `跳过 fork ${r?.full_name || "未知"}：${e.message}`);
      continue;
    }
    if (!row) continue;
    seen.add(row.id);
    const tags = applyAutoTags(row);
    for (const t of tags) addRepoTag.run(row.id, tagByName(t).id, "auto");
    const known = db.query("SELECT upstream FROM repos WHERE id=?").get(row.id);
    if (!known?.upstream) {
      // gh() 对被 GitHub 封禁/无权限的仓库返回 {forbidden:true}（非 throw），
      // 跳过上游查询即可，别让它中断整轮同步。
      const full = await gh(`/repos/${r.full_name}`);
      if (full?.forbidden) {
        log("warn", `跳过 fork ${r.full_name} 上游查询：${full.message}`);
      } else {
        const up = full?.parent?.full_name || full?.source?.full_name || null;
        if (up) db.query("UPDATE repos SET upstream=? WHERE id=?").run(up, row.id);
      }
    }
    count++;
    syncState.done = count;
    if (count % 10 === 0) broadcast({ type: "progress", ...syncState });
  }
  return { count, login, seen, full };
}

/**
 * 同步收尾：把「库里有、但这一轮上游没列到」的 starred/fork 标记为 detached。
 *
 * 为什么必须做：upsert 只会更新/新增，从不删除。用户在 GitHub 上取消了 star，
 * 本地库里那条记录会永远留着，列表越用越脏，且和 GitHub 上的真实状态对不上。
 *
 * 为什么不能直接 DELETE：本地挂着手写备注、自定义标签、待读/放弃标记、README 缓存，
 * 删掉就没了。改成打标记 + 默认不展示，用户想找回还能在「已取消」里看见。
 *
 * 前提条件（缺一不可，否则会把整库误标）：
 *   ① 这一轮真的跑完了（不是中途抛错中断）
 *   ② 这一轮确实从头翻到了尾（incremental 提前 StopPaging 时不能判）
 *   ③ 上游至少返回了 1 条（空结果几乎都是接口异常，不是用户清空了收藏）
 */
function markDetached(source, seen, full, since) {
  // 没翻到底就别判：只扫了前几页，后面全是「没扫到」而不是「上游没了」。
  // 唯一的例外是增量同步：它虽然提前刹车，但扫过的区间是完整的——
  // /user/starred 按 starred_at 倒序返回，扫到 oldest 就停，所以 [oldest, now] 这一段的
  // 每一页都翻过了。落在这一段里却没出现的，就是真取消了。
  if (!full && !since) { log("info", `${source}：本次未翻到底，跳过「已取消」判定`); return 0; }
  if (!seen || seen.size === 0) return 0;
  // 只处理这一轮扫过的那类：star 轮就只判 starred，fork 轮只判 fork。
  // 混着判会把「只同步了 star」时所有 fork 全标成已取消。
  let sql = "SELECT id FROM repos WHERE source=? AND COALESCE(detached,0)=0";
  const args = [source];
  if (!full && since) {
    sql += " AND starred_at IS NOT NULL AND starred_at >= ?";
    args.push(since);
  }
  const rows = db.query(sql).all(...args);
  const gone = rows.map((r) => r.id).filter((id) => !seen.has(id));
  if (gone.length === 0) return 0;
  const upd = db.prepare("UPDATE repos SET detached=1, detached_at=? WHERE id=?");
  for (const id of gone) upd.run(now(), id);
  log("info", `${source}：上游已无 ${gone.length} 个（取消 star / 删了仓库），已标记 detached${full ? "" : `（增量区间 ${String(since).slice(0, 10)} 起）`}`);
  return gone.length;
}

async function runSync(kind = "all") {
  if (syncState.running) return syncState;
  syncState = { running: true, kind, total: 0, done: 0, started_at: now(), error: null, phase: "启动" };
  broadcast({ type: "progress", ...syncState });
  let stars = 0, forks = 0;
  let t0 = Date.now();
  try {
    let detached = 0;
    if (kind === "all" || kind === "starred") {
      const r = await syncStarred();
      stars = r.count;
      setMeta("stars_synced_at", now());
      if (!LOGIN()) setMeta("login", process.env.RADAR_LOGIN || "");
      // 增量同步会提前停止翻页，此时 seen 只是"最近的一部分"，拿它判谁消失了必然误杀
      detached += markDetached("starred", r.seen, r.full, r.oldest);
    }
    if (kind === "all" || kind === "fork") {
      const r = await syncForks();
      forks = r.count;
      setMeta("forks_synced_at", now());
      setMeta("login", r.login);
      detached += markDetached("fork", r.seen, r.full);
    }
    syncState.detached = detached;
    setMeta("last_sync_ok", now());
    setMeta("last_sync_error", "");
    log("info", `同步完成：star ${stars}，fork ${forks}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    syncState.error = e.message;
    // 失败也要盖时间戳：否则 last_sync_ok 一直停在很久以前，
    // msUntilNext 每次都返回 0，定时器退化成「每 5 秒重试一次」死循环打 GitHub。
    setMeta("last_sync_attempt", now());
    setMeta("last_sync_error", e.message.slice(0, 300));
    log("error", `同步失败：${e.message}`);
  } finally {
    syncState = { ...syncState, running: false, phase: "结束" };
    broadcast({ type: "done", ...syncState });
    scheduleAutoSync();
  }
  return syncState;
}

/* ---------------------------------------------------------------- README 懒加载 */
async function fetchReadme(row) {
  const cached = db.query("SELECT readme FROM repos WHERE id=?").get(row.id);
  if (cached?.readme) return cached.readme;
  const headers = {
    "User-Agent": "open-source-radar/1.0",
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const tk = currentToken();
    if (tk) headers.Authorization = `Bearer ${tk}`;
  let res;
  try {
    res = await fetch(`${GH}/repos/${row.full_name}/readme`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const why = e.name === "TimeoutError" ? "15s 超时" : e.message;
    throw new Error(`连不上 GitHub（${why}），稍后重试`);
  }
  if (res.status === 404) return "";
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint = /access blocked/i.test(body) ? "仓库被 GitHub 封禁" : `HTTP ${res.status}`;
    throw new Error(`README 获取失败：${hint}`);
  }
  const text = (await res.text()).slice(0, 200000);
  db.query("UPDATE repos SET readme=? WHERE id=?").run(text, row.id);
  return text;
}

/* ---------------------------------------------------------------- 临时仓库收编 */
// 发现页的仓库不在本地库：点开时按 GitHub id 拉详情入库（source=discover），
// 抽屉的简介/标签/README/隐藏等操作才有落点。404/403（TOS 封禁等）返回 null。
async function adoptRepo(id) {
  const ghRepo = await gh(`/repositories/${id}`).catch(() => null);
  if (!ghRepo || !ghRepo.id || !ghRepo.full_name) return null;
  const row = saveRepo(ghRepo, "discover", null);
  if (!row) return null;
  const tags = applyAutoTags(row);
  for (const t of tags) {
    const tag = tagByName(t);
    addRepoTag.run(row.id, tag.id, "auto");
  }
  return db.query("SELECT * FROM repos WHERE id=?").get(row.id);
}

/* ---------------------------------------------------------------- 发现：热门开源项目 */
const CN_BLOCK = /(色情|博彩|赌博|代刷|刷单|外挂辅助售卖)/;

// 发现页默认阈值与查询构建都在 lib/discover.mjs：纯函数，可单测。
// （拼 GitHub 搜索语法时一个负号就能把 query 玩坏，得靠测试守边界。）
async function discover({ sort = "stars", q = "", stars, days, per_page = 30, page = 1 } = {}) {
  const { query, sortField } = buildDiscoverQuery({ sort, q, stars, days });
  const data = await gh(`/search/repositories?q=${encodeURIComponent(query)}&sort=${sortField}&order=desc&per_page=${per_page}&page=${page}`);
  if (data.notFound) return { items: [], total: 0, query };
  const items = (data.items || []).filter((r) => {
    const hay = `${r.full_name} ${r.description || ""} ${(r.topics || []).join(" ")}`;
    return !CN_BLOCK.test(hay);
  });
  return {
    total: data.total_count || 0,
    query,
    rate: rateFor(rates, "search"),
    items: items.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      html_url: r.html_url,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      topics: r.topics || [],
      pushed_at: r.pushed_at,
      created_at: r.created_at,
      license: r.license?.spdx_id || "",
      homepage: r.homepage || "",
      digest: ruleDigest(r).digest.split("\n")[0],
      tags: ruleDigest(r).tags,
    })),
  };
}

/* ---------------------------------------------------------------- 新版本检查 */
async function checkReleases(limit = 25) {
  const rows = db
    .query(
      `SELECT id, full_name, pushed_at FROM repos
        WHERE source='starred' AND archived=0 AND COALESCE(detached,0)=0
        ORDER BY stars DESC LIMIT ?`
    )
    .all(limit);
  let changed = 0;
  for (const r of rows) {
    try {
      const d = await gh(`/repos/${r.full_name}/releases/latest`);
      if (d.notFound) continue;
      const prev = db.query("SELECT tag FROM releases WHERE repo_id=?").get(r.id);
      const item = {
        tag: d.tag_name,
        name: d.name || d.tag_name,
        published_at: d.published_at,
        url: d.html_url,
      };
      if (!prev) {
        db.query("INSERT INTO releases (repo_id,tag,name,published_at,url,checked_at) VALUES (?,?,?,?,?,?)")
          .run(r.id, item.tag, item.name, item.published_at, item.url, now());
      } else if (prev.tag !== item.tag) {
        db.query("UPDATE releases SET tag=?,name=?,published_at=?,url=?,checked_at=? WHERE repo_id=?")
          .run(item.tag, item.name, item.published_at, item.url, now(), r.id);
        changed++;
      } else {
        db.query("UPDATE releases SET checked_at=? WHERE repo_id=?").run(now(), r.id);
      }
      await sleep(100);
    } catch (e) {
      log("warn", `release 检查失败 ${r.full_name}: ${e.message}`);
    }
  }
  setMeta("releases_checked_at", now());
  return { checked: rows.length, changed };
}

/* ---------------------------------------------------------------- HTTP 层 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
// 未登录也要能取到的页面资源：登录页自身 + 它引用的 css/js + 主题预览页。
// 新增 public/ 下的页面资源时，记得加进这里，否则未登录访问会被 302 回 /login。
const PAGE_ALIAS = { "/login": "login.html", "/themes": "themes.html" };

const ASSET_FILES = new Set([
  "login.html", "login.js",
  "themes.html", "themes.css", "themes.js",
  "app.css", "app.js", "md.js", "rules.js", "ai.js", "favicon.ico",
]);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function serveStatic(pathname) {
  const safe = pnorm(pathname).replace(/^(\.\.[/\\])+/, "");
  // /login → login.html（不能落到 index.html）

  const rel = PAGE_ALIAS[safe] || (safe === "/" ? "index.html" : safe);
  let p = join(PUBLIC_DIR, rel);
  if (!p.startsWith(PUBLIC_DIR)) return new Response("forbidden", { status: 403 });
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!existsSync(p)) {
    p = join(PUBLIC_DIR, "index.html");
    if (!existsSync(p)) return new Response("not found", { status: 404 });
  }
  // 安全响应头：页面大量用 innerHTML 渲染 GitHub 来源的字符串（描述、topics、README），
  // 一处转义漏掉就是存储型 XSS。
  // 注意：style-src/script-src 都是 'self'，内联 <script>、<style>、style="…" 属性
  // 会被整条丢弃且不报错（attribute 保留、CSSOM 为空），页面表现为「样式全丢、按钮无效」。
  // 所有页面资源必须外链到 public/ 下的 .js/.css，新增静态资源记得加进下面的放行名单。
  return new Response(readFileSync(p), {
    headers: {
      "content-type": MIME[extname(p)] || "application/octet-stream",
      "cache-control": "no-cache",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
    },
  });
}

// note 与 digest 语义不同：digest 是「这是什么」，note 是「我为什么留它」。
// 两个都允许手改；只有 digest 会带 digest_src='manual'，note 不参与来源判定。
const UPDATABLE = new Set(["digest", "homepage", "note"]);

// WHERE 构造拆出来，让「列表」和「侧栏计数」用同一套判据。
// 之前侧栏的 4 个库计数直接 GROUP BY source 数，既没排除 source='discover'，
// 也没管 archived —— 「全部 294」和实际列表条数对不上就是这么来的。
function repoWhere({ q = "", source = "", tag = "", lang = "", scope = "all", view = "" }) {
  const where = [];
  const args = [];
  // hidden 谓词按 scope/source 组合显式构造。曾用 where[indexOf(...)] 改写，
  // scope=hidden 时那项根本没 push，indexOf 返回 -1 → where[-1]=... 无效，
  // 隐藏过滤消失，scope=hidden 会返回全部仓库（实测 226 条）。
  const wantHidden = scope === "hidden" || source === "hidden";
  // 「已取消」= 本地库里有、但这一轮同步上游没再列到（远端取消 star / 仓库被删）。
  // 默认视图必须排掉它们，否则会出现「GitHub 上已经不 star 了，本地列表还挂着」的对不上。
  const wantDetached = scope === "detached" || source === "detached";
  where.push(wantHidden ? "h.repo_id IS NOT NULL" : "h.repo_id IS NULL");
  // 「已隐藏」是用户主动的操作，它的语义是「我隐藏了哪些」——不该被 detached 再过滤一遍，
  // 否则一个既隐藏、上游又取消了的仓库会两个入口都看不到，等于凭空消失。
  // 反过来「已取消」排掉 hidden，因为那些在「已隐藏」里已经看得到了，不重复出现。
  // 「已放弃」也是用户主动的操作，和「已隐藏」同理：dropped+detached、dropped+hidden
  // 这两种组合如果两边各过滤一次，记录会在所有视图里都取不到——点了放弃就再也找不回来。
  // 判据：任一用户主动视图（hidden / detached / dropped）下，不再叠加别的标志位过滤。
  const viewDropped = view === "dropped";
  if (!wantHidden) {
    where.push(wantDetached ? "COALESCE(r.detached,0) = 1" : "COALESCE(r.detached,0) = 0");
  }
  if (source === "starred" || source === "fork" || source === "discover") {
    where.push("r.source = ?"); args.push(source);
  } else if (!wantHidden && !wantDetached) {
    // 默认「全部」视图不掺发现页收编的临时仓库，只在我明确点「发现过的」时出现
    where.push("r.source != 'discover'");
  }
  // 视图过滤：待读 / 已放弃 / 停滞。三个都是 r 表上的标志位或时间，不需要额外 join。
  // 待读同理：标了待读、上游又取消 star 的仓库，在「待读队列」里必须还能找到，
  // 否则用户既想看又看不到。所以 view=toread 时把上面的 detached 谓词撤掉。
  if (view === "toread") {
    const i = where.findIndex((w) => w.includes("r.detached"));
    if (i >= 0) where.splice(i, 1);
    where.push("r.toread = 1 AND r.dropped = 0");
  } else if (view === "dropped") {
    const i = where.findIndex((w) => w.includes("r.detached"));
    if (i >= 0) where.splice(i, 1);
    where.push("r.dropped = 1");
  }
  else if (view === "stale") {
    // 归档或 180 天没推送。和 lib/insight.mjs 的 stagnation() 用同一判据，
    // 服务端用 SQL 是为了能在库内直接过滤 228 条，不必全拉回内存。
    // 必须排除已放弃的：/api/status 的 viewCount.stale 就是这么算的，
    // 这边漏了会出现「侧栏写 12、点进去 15 个」。
    where.push("COALESCE(r.dropped,0) = 0 AND (r.archived = 1 OR (r.pushed_at IS NOT NULL AND r.pushed_at != '' AND r.pushed_at < ?))");
    args.push(new Date(Date.now() - 180 * 86400000).toISOString());
  } else if (!wantHidden) {
    // 其他视图默认不显示已放弃的（它们只在「已放弃」里出现）。
    // 但「已隐藏」视图不能叠这条：既隐藏又放弃的仓库会两个入口都取不到，
    // 用户点完放弃就再也找不到它、也就无法恢复。
    where.push("COALESCE(r.dropped,0) = 0");
  }
  if (lang) { where.push("r.language = ?"); args.push(lang); }
  if (tag) {
    // 点父标签要能带出子标签下的仓库，否则两级分组等于白做
    where.push(`r.id IN (SELECT rt.repo_id FROM repo_tags rt JOIN tags t ON t.id=rt.tag_id
      WHERE t.name=? OR t.parent=?)`);
    args.push(tag, tag);
  }
  if (q.trim()) {
    where.push("(r.full_name LIKE ? OR r.description LIKE ? OR r.digest LIKE ? OR r.topics LIKE ? OR r.note LIKE ?)");
    const like = `%${q.trim()}%`;
    args.push(like, like, like, like, like);
  }
  return { where, args };
}

function repoList({ q = "", source = "", tag = "", lang = "", sort = "stars", scope = "all", view = "", limit = 5000 }) {
  // limit 来自查询参数，直接拼进 SQL 会得到 LIMIT NaN（实测 500 no such column: NaN），
  // 超大值还会拖出全表。收敛成 1..2000 的有限整数。
  limit = Math.min(2000, Math.max(1, Math.trunc(Number(limit)) || 500));
  const { where, args } = repoWhere({ q, source, tag, lang, scope, view });
  const orderMap = {
    stars: "r.stars DESC",
    pushed: "r.pushed_at DESC",
    starred: "r.starred_at DESC",
    name: "r.full_name ASC",
    forked: "r.forks DESC",
  };
  const order = orderMap[sort] || orderMap.stars;
  const sql = `
    SELECT r.*, h.repo_id AS hidden,
      (SELECT GROUP_CONCAT(t.name, '|') FROM repo_tags rt JOIN tags t ON t.id=rt.tag_id WHERE rt.repo_id=r.id) AS tag_names,
      (SELECT tag FROM releases WHERE repo_id=r.id) AS latest_tag,
      (SELECT published_at FROM releases WHERE repo_id=r.id) AS latest_release_at
    FROM repos r LEFT JOIN hidden h ON h.repo_id = r.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${order} LIMIT ${Number(limit)}`;
  const rows = db.query(sql).all(...args).map((r) => ({ ...r, tags: r.tag_names ? r.tag_names.split("|") : [] }));
  return rows;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req) {
    const u = new URL(req.url);
    const p = u.pathname;

    /* ---- 登录态接口（无需鉴权） ---- */
    if (p === "/api/auth/state") {
      const s = sessionInfo(req);
      return json({
        authed: !!s,
        login: s?.login || getMeta("login") || "",
        has_token: !!currentToken(),
        token_source: ENV_TOKEN ? "env" : runtimeToken ? "login" : "none",
        needs_login: !s,
      });
    }

    if (p === "/api/auth/login" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const token = String(b.token || "").trim();
      // 必须有 token 才放行
      if (!token) return json({ error: "请填写 GitHub Personal Access Token" }, 400);
      if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})$/.test(token))
        return json({ error: "token 格式不对，应以 ghp_ / gho_ / ghu_ / ghs_ / github_pat_ 开头" }, 400);
      // 真调一次 GitHub 验证
      let who;
      try {
        const res = await fetch(`${GH}/user`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "open-source-radar/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (res.status === 401) return json({ error: "token 无效或已过期（GitHub 返回 401）" }, 401);
        if (!res.ok) return json({ error: `GitHub 校验失败 HTTP ${res.status}` }, 502);
        who = await res.json();
      } catch (e) {
        return json({ error: `连不上 GitHub：${e.message}` }, 502);
      }
      // 权限检查：能读自己的 starred 才算够用
      storeToken(token, who.login);
      runtimeToken = token;
      setMeta("login", who.login);
      const sid = newSession(who.login);
      log("info", `登录成功：${who.login}`);
      return new Response(JSON.stringify({
        ok: true, login: who.login, name: who.name || who.login, avatar: who.avatar_url,
      }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        },
      });
    }

    if (p === "/api/auth/logout" && req.method === "POST") {
      const sid = sidFromReq(req);
      if (sid) db.query("DELETE FROM sessions WHERE sid=?").run(sid);
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    /* ---- 静态资源：登录页放行，其余在无会话时重定向 ---- */
    if ((req.method === "GET" || req.method === "HEAD") && !p.startsWith("/api/")) {
      const isLoginPage = p === "/login" || p === "/login.html";
      // 放行登录页自身及其所需资源。login.js/themes.* 是外链化后新增的，
      // 漏一个就会 302 回 /login，页面静默失去交互（曾整页无样式无脚本）。
      // 用「按 alias 解析后的文件名」判断，避免 /themes 这种短路径漏网
      // （它 alias 到 themes.html，但路径本身不以 .html 结尾，正则匹配不到 → 302）。
      const isAsset = ASSET_FILES.has(PAGE_ALIAS[p] || p.replace(/^\//, ""));
      if (!isLoginPage && !isAsset) {
        // 未登录直接跳登录页（首屏拦截）
        if (!ENV_TOKEN && !sessionInfo(req)) {
          return new Response(null, { status: 302, headers: { location: "/login" } });
        }
      }
      return serveStatic(p);
    }

    /* ---- 其余 API 一律要求登录 ---- */
    if (p.startsWith("/api/") && !p.startsWith("/api/auth/")) {
      if (!ENV_TOKEN && !sessionInfo(req)) return json({ error: "未登录", needs_login: true }, 401);
    }

    /* ---- SSE 进度 ---- */
    if (p === "/api/events") {
      if (!ENV_TOKEN && !sessionInfo(req)) return json({ error: "未登录", needs_login: true }, 401);
      let closed = false;
      const stream = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          // enqueue 失败就把这条流判死：否则 20s 一次的 ping 会继续往已断的流里写，
          // 一直抛到 abort 到达才停（不会真泄漏，但中间这段时间在无声重试）。
          const send = (o) => {
            if (closed) return;
            try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { closed = true; }
          };
          send({ type: "hello", ...syncState });
          listeners.add(send);
          const ping = setInterval(() => send({ type: "ping", at: now() }), 20000);
          req.signal.addEventListener("abort", () => {
            closed = true;
            clearInterval(ping);
            listeners.delete(send);
            try { ctrl.close(); } catch {}
          });
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    try {
      /* ---- 状态 ---- */
      if (p === "/api/status") {
        // 视图计数：待读 / 已放弃 / 停滞。前端侧栏要显示数字，后端一次给全。
        // 判据与 repoList 的 view 过滤、lib/insight.mjs 的 stagnation 保持一致。
        //
        // 「全部」这个数字曾经是 starred+fork 直接相加，结果 297 个库里
        // 侧栏写 226、列表给 294：discover 那几条没排除、hidden 那条也没扣。
        // 现在四个库计数全部走同一套 repoWhere，和点进去的列表同源。
        const cnt = (opt) => {
          const { where, args } = repoWhere(opt);
          return db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id = r.id
            WHERE ${where.join(" AND ")}`).get(...args)?.n || 0;
        };
        const viewCount = {
          all: cnt({ scope: "all" }),
          starred: cnt({ scope: "all", source: "starred" }),
          fork: cnt({ scope: "all", source: "fork" }),
          discover: cnt({ scope: "all", source: "discover" }),
          // 「已隐藏」走 repoWhere，和点进去的列表同源。早先直接 COUNT(hidden) 全表，
          // 把 dropped 的、以及仓库已被清掉的孤儿行都数进去，实测侧栏写 3、列表只有 1 条。
          // 注意不能加 view="dropped"：那就是「既隐藏又放弃」的子集，不是「我隐藏了哪些」。
          hidden: cnt({ scope: "hidden" }),
          // 已取消：上游同步里消失的。默认视图已排除，这里单独给个数让用户能翻回去看。
          // 同样走 repoWhere —— 手写 SQL 会漏掉 dropped 条件，又是「侧栏 3、列表 2」。
          detached: cnt({ scope: "detached" }),
          toread: cnt({ scope: "all", view: "toread" }),
          dropped: cnt({ scope: "all", view: "dropped" }),
          stale: cnt({ scope: "all", view: "stale" }),
        };
        // 标签与语言的计数必须和「点进去看到的列表」同源，否则侧栏写 10、列表给 12。
        // 语言这里原来漏了 source!='discover'（收编进库的临时仓库不该进主列表计数）
        // 和 dropped=0（已放弃的也不在主列表里）。
        // 标签计数同样过滤掉 discover / dropped / hidden，理由见下方 langs
        // 标签计数必须和「点进去看到的列表」同源。列表侧点父标签会带出子标签下的仓库
        // （t.name=? OR t.parent=?），这里只按 rt.tag_id=t.id 数就会少算——
        // 实测父标签 AI 侧栏写 1、点进去 2 条。改成对每个标签跑一次 cnt({tag})。
        const tagMeta = db.query("SELECT id, name, kind, color, parent FROM tags ORDER BY COALESCE(parent,''), name").all();
        const tagN = new Map();
        for (const t of tagMeta) tagN.set(t.id, cnt({ scope: "all", tag: t.name }));
        const tags = tagMeta.map((t) => ({ ...t, n: tagN.get(t.id) || 0 }))
          .sort((a, b) => (a.parent || "").localeCompare(b.parent || "") || b.n - a.n || a.name.localeCompare(b.name));
        const langs = db.query(`
          SELECT language, COUNT(*) n FROM repos r
          WHERE language != '' AND COALESCE(dropped,0) = 0 AND source != 'discover'
            AND COALESCE(detached,0) = 0 AND id NOT IN (SELECT repo_id FROM hidden)
          GROUP BY language ORDER BY n DESC LIMIT 40`).all();
        return json({
          login: getMeta("login"),
          authed: !!sessionInfo(req),
          token_source: ENV_TOKEN ? "env" : runtimeToken ? "login" : "none",
          token: currentToken() ? "已配置" : "未配置（匿名 60 次/小时）",
          // rate 指 core 桶（同步/详情走的都是 core），另外给全量桶供界面按需取
          rate: rateFor(rates, "core"),
          // 每个桶都过一遍 rateFor：窗口已翻篇的桶余量回满并标 expired，
          // 否则 /api/status 会把过期数字原样吐给界面（实测 search 停在 28 而窗口早过了）。
          rates: Object.fromEntries(Object.keys(rates).map((k) => [k, rateFor(rates, k)])),
          rate_text: rateText(rateFor(rates, "core")),
          counts: {
            all: viewCount.all,
            starred: viewCount.starred,
            fork: viewCount.fork,
            discover: viewCount.discover,
            hidden: viewCount.hidden,
            detached: viewCount.detached,
            toread: viewCount.toread,
            dropped: viewCount.dropped,
            stale: viewCount.stale,
          },
          stars_synced_at: getMeta("stars_synced_at"),
          forks_synced_at: getMeta("forks_synced_at"),
          releases_checked_at: getMeta("releases_checked_at"),
          sync: syncState,
          // 前端据此决定抽屉里显示「问 AI」输入框还是「去配置」引导
          ai_enabled: getAiConfig().enabled,
          ai_model: getAiConfig().model,
          tags,
          langs,
          recent_events: db.query("SELECT * FROM events ORDER BY id DESC LIMIT 20").all(),
        });
      }

      /* ---- 列表 ---- */
      if (p === "/api/repos") {
        const rows = repoList(Object.fromEntries(u.searchParams));
        return json({ count: rows.length, items: rows });
      }

      /* ---- 单仓 ---- */
      const mRepo = p.match(/^\/api\/repo\/(\d+)$/);
      if (mRepo) {
        const id = Number(mRepo[1]);
        let row = db.query("SELECT * FROM repos WHERE id=?").get(id);
        if (!row) {
          row = await adoptRepo(id);
          if (!row) return json({ error: "not found" }, 404);
        }
        // 记一次打开：清理建议要靠 open_count 判断「收藏了却从没看过」。
        // 只累加，不做去重——同一天反复看也是「关注过」的证据。
        db.query("UPDATE repos SET open_count=COALESCE(open_count,0)+1, opened_at=COALESCE(opened_at,?) WHERE id=?")
          .run(now(), id);
        const tags = db.query(
          "SELECT t.name, t.kind FROM repo_tags rt JOIN tags t ON t.id=rt.tag_id WHERE rt.repo_id=?", ).all(id);
        // 相似仓库：同库内算加权 Jaccard，纯粹为「还可能有这些」的推荐位。
        // 标签一次查全再按 repo_id 分组——早先每个仓库单独查一次，228 个库就是
        // 228 条 SQL，抽屉每次打开都全表扫一遍。
        // 相似推荐只从「还在我库里、我没主动藏起来」的仓库里挑：
        // 上游已取消(detached)的不该再被推荐回来，已隐藏的是用户主动不想看的。
        // discover 保留——那是发现页看过的别人的仓库，作为「还可能有这些」是有价值的。
        const all = db.query(`SELECT id, full_name, owner, language, topics, description, stars FROM repos r
          WHERE COALESCE(r.detached,0)=0 AND r.id NOT IN (SELECT repo_id FROM hidden)`).all();
        const tagByRepo = new Map();
        for (const t of db.query("SELECT rt.repo_id, t.name FROM repo_tags rt JOIN tags t ON t.id=rt.tag_id").all()) {
          if (!tagByRepo.has(t.repo_id)) tagByRepo.set(t.repo_id, []);
          tagByRepo.get(t.repo_id).push(t.name);
        }
        const sims = similarTo({ ...row, tags: tags.map((t) => t.name) },
          all.map((x) => ({ ...x, tags: tagByRepo.get(x.id) || [] })), 5);
        return json({
          ...row,
          open_count: (row.open_count || 0) + 1,
          tags,
          stagnation: stagnation(row),
          fork_lag: row.fork_behind != null ? { behind: row.fork_behind, ahead: row.fork_ahead || 0 } : null,
          similar: sims,
        });
      }

      /* ---- 仓库标记：待读 / 放弃 / 备注 ---- */
      if (p === "/api/repo/flag" && req.method === "POST") {
        const b = await req.json();
        const id = Number(b.id);
        if (!id) return json({ error: "bad id" }, 400);
        const exists = db.query("SELECT id FROM repos WHERE id=?").get(id);
        if (!exists) return json({ error: "not found" }, 404);
        if (b.toread !== undefined) db.query("UPDATE repos SET toread=? WHERE id=?").run(b.toread ? 1 : 0, id);
        if (b.dropped !== undefined) {
          db.query("UPDATE repos SET dropped=?, dropped_at=? WHERE id=?")
            .run(b.dropped ? 1 : 0, b.dropped ? now() : null, id);
        }
        const row = db.query("SELECT id, toread, dropped, dropped_at, note FROM repos WHERE id=?").get(id);
        return json({ ok: true, ...row });
      }

      /* ---- fork 落后对比（真打 GitHub compare 接口）---- */
      if (p === "/api/fork/compare" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        // 同样要防 NaN：LIMIT ? 绑到非整数会抛 datatype mismatch。
        // Math.trunc 不能少，1.5 也会抛。
        const limit = Math.min(50, Math.max(1, Math.trunc(Number(b.limit)) || 50));
        // 只比没比过的，或用户显式要求重算的
        const rows = b.force
          // 每个 fork 都要打一次 compare，别浪费在已经取消/隐藏的仓库上
          ? db.query("SELECT * FROM repos WHERE is_fork=1 AND COALESCE(detached,0)=0 AND id NOT IN (SELECT repo_id FROM hidden) LIMIT ?").all(limit)
          : db.query("SELECT * FROM repos WHERE is_fork=1 AND COALESCE(detached,0)=0 AND fork_checked_at IS NULL AND id NOT IN (SELECT repo_id FROM hidden) LIMIT ?").all(limit);
        const out = [];
        for (const r of rows) {
          // upstream 形如 owner/repo；归一化时已存好。缺就得先补一次详情，否则没法比。
          let upstream = r.upstream;
          let branch = r.branch || "";
          try {
            if (!upstream || !branch) {
              const me = await gh(`/repos/${r.full_name}`);
              upstream = upstream || me?.parent?.full_name || "";
              branch = branch || me?.default_branch || "main";
            }
            if (!upstream) { out.push({ id: r.id, full_name: r.full_name, error: "拿不到上游仓库" }); continue; }
            const upName = upstream.split("/")[1];
            // compare 的两端必须同属一个 fork 网络，所以两端都写成 owner:branch。
            // base=上游、head=我的 fork：返回的 behind_by 就是「上游有我没合进来的提交数」。
            const cmp = await gh(
              `/repos/${r.full_name}/compare/${encodeURIComponent(upstream.split("/")[0])}:${branch}...${encodeURIComponent(r.owner)}:${branch}`
            );
            const lag = forkLag(cmp);
            db.query("UPDATE repos SET fork_behind=?, fork_ahead=?, fork_checked_at=?, branch=COALESCE(branch,?) WHERE id=?")
              .run(lag.behind ?? null, lag.ahead ?? null, now(), branch, r.id);
            out.push({ id: r.id, full_name: r.full_name, upstream: `${upstream.split("/")[0]}/${upName}`, ...lag, text: forkLagText(lag) });
          } catch (e) {
            out.push({ id: r.id, full_name: r.full_name, error: e.message });
          }
        }
        if (out.some((x) => !x.error)) log("info", `fork 对比完成 ${out.filter((x) => !x.error).length}/${out.length}`);
        return json({ ok: true, checked: out.length, items: out });
      }

      /* ---- 智能清理建议：只出清单，绝不自动取消 star ---- */
      if (p === "/api/cleanup") {
        // 只在「还在我的库里」的范围内给建议：
        // 上游已取消(detached)、发现页收编(discover)、已隐藏 都不该出现在清理清单里——
        // 它们要么已经不在我的收藏里，要么本来就是别人的仓库。
        const rows = db.query(`SELECT * FROM repos r
          WHERE COALESCE(r.detached,0)=0 AND r.source != 'discover'
            AND r.id NOT IN (SELECT repo_id FROM hidden)`).all();
        const cand = cleanupCandidates(rows, Date.now(), {
          // 直接 Number("abc") 是 NaN，会让判定全为 false 或全为 true，
          // 页面呈现出「一条不剩 / 全都建议删」两种假象。非法值一律回落默认。
          idleDays: clampNum(u.searchParams.get("idleDays"), 365, 1, 3650),
          neverOpenedDays: clampNum(u.searchParams.get("neverOpenedDays"), 180, 1, 3650),
        });
        // 补上给人看的字段，前端不再二次计算
        const byId = new Map(rows.map((r) => [r.id, r]));
        return json({
          count: cand.length,
          items: cand.map((c) => ({
            ...c,
            full_name: byId.get(c.id)?.full_name || c.full_name,
            html_url: byId.get(c.id)?.html_url,
            stars: byId.get(c.id)?.stars,
            pushed_at: byId.get(c.id)?.pushed_at,
            language: byId.get(c.id)?.language,
            digest: byId.get(c.id)?.digest,
            description: byId.get(c.id)?.description,
            archived: byId.get(c.id)?.archived,
          })),
          total: rows.length,
        });
      }

      /* ---- AI 设置 ---- */
      if (p === "/api/ai/config") {
        // default_extra_prompt 一起下发：「恢复默认」按钮要用它填回文本框，
        // 这段长文案只该有一份定义（lib/ai.mjs），不能前后端各写一遍。
        if (req.method === "GET") {
          const cfg = getAiConfig();
          const prov = matchProvider(cfg.base_url);
          return json({
            ...cfg,
            presets: AI_PRESETS,
            provider: prov.id,
            provider_kind: prov.kind,
            provider_label: prov.label,
            default_extra_prompt: DEFAULT_EXTRA_PROMPT,
          });
        }
        if (req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const cfg = {
            enabled: !!b.enabled,
            base_url: String(b.base_url || "").trim(),
            model: String(b.model || "").trim(),
            max_tokens: Number(b.max_tokens) || 2000,
            temperature: Number.isFinite(Number(b.temperature)) ? Number(b.temperature) : 0.2,
            extra_prompt: String(b.extra_prompt || ""),
          };
          if (cfg.enabled || cfg.base_url || cfg.model) {
            const errs = validateAiConfig(cfg);
            if (errs.length) return json({ error: errs.join("；"), errors: errs }, 400);
          }
          for (const [k, v] of Object.entries(cfg)) setMeta(`ai_${k}`, v);
          // key 单独走：不传就不动，传空串才清除。这样前端只改 base_url 时不会把 key 抹掉。
          if (b.api_key !== undefined) setAiKey(b.api_key);
          // base_url 原样落日志会泄密：中转站常见写法是 https://x/v1?key=sk-...。
          // 只留 origin+pathname，query 与 userinfo 一律剥掉。
          log("info", `AI 配置已更新（${safeUrlForLog(cfg.base_url)} / ${cfg.model}）`);
          return json({ ok: true, ...getAiConfig() });
        }
      }
      /* 拉上游模型列表。对齐 Open WebUI 的「协议优先」实践（docs.openwebui.com
         getting-started/connect-a-provider）：/models 能列出就拉，列不到就提示
         手填，不让「验证失败」变成「配不了」。 */
      if (p === "/api/ai/models" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const cfg = getAiConfig();
        // 允许用表单里还没保存的 base_url/key 直接试，省得先存一次
        const baseUrlRaw = String(b.base_url || cfg.base_url || "").trim();
        const key = String(b.api_key || "").trim() || aiKey();
        if (!baseUrlRaw) return json({ error: "先填 Base URL" }, 400);
        if (!key) return json({ error: "先填 API Key" }, 400);
        // 有的服务商 /models 走非标准路径（如 Anthropic 的 native 端点没有 /v1/models），
        // 用归一化后的地址尝试，拿不到再按「验证失败但 chat 仍可用」如实回
        const baseUrl = resolveBaseUrl(baseUrlRaw);
        try {
          const res = await fetch(`${baseUrl}/models`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
          });
          const text = await res.text();
          if (!res.ok) {
            let msg = text.slice(0, 300);
            try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch {}
            // Open WebUI 的结论：/models 验证失败不代表 chat 不通，如实告知并建议手填
            return json({ error: `上游 ${res.status}：${msg}`, models_ok: false }, 502);
          }
          const data = JSON.parse(text);
          const ids = normalizeModels(data);
          if (!ids.length) return json({ error: "上游没返回任何模型", raw: text.slice(0, 300) }, 502);
          return json({ ok: true, models: ids });
        } catch (e) {
          return json({ error: e.name === "TimeoutError" ? "上游 15 秒没响应" : e.message }, 502);
        }
      }
      if (p === "/api/ai/test" && req.method === "POST") {
        const cfg = getAiConfig();
        if (!cfg.base_url || !cfg.model) return json({ error: "先填 base_url 与 model" }, 400);
        try {
          const r = await aiChat([{ role: "user", content: "只回复两个字：可用" }], { ...cfg, max_tokens: 20 });
          return json({ ok: true, reply: r.content.slice(0, 200), model: r.model });
        } catch (e) {
          return json({ error: e.message }, 502);
        }
      }
      /* ---- 单仓 AI 对话 ---- */
      if (p === "/api/ai/chat" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const id = Number(b.id);
        const question = String(b.question || "").trim();
        if (!id) return json({ error: "bad id" }, 400);
        if (!question) return json({ error: "问题为空" }, 400);
        const cfg = getAiConfig();
        if (!cfg.enabled) return json({ error: "AI 未启用（在「AI 设置」里勾选启用）" }, 400);
        const row = db.query("SELECT * FROM repos WHERE id=?").get(id);
        if (!row) return json({ error: "not found" }, 404);
        const ctx = await aiRepoContext(row);
        const history = Array.isArray(b.history)
          ? b.history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
              .slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
          : [];
        const messages = buildMessages(row, history, question, { ...ctx, extraPrompt: cfg.extra_prompt });
        try {
          const r = await aiChat(messages, cfg);
          // 把回答存成 ai_summary：卡片上就能看到「AI 怎么看这库」，不用重开对话
          if (!getMeta(`ai_sum_${id}`)) setMeta(`ai_sum_${id}`, "1");
          db.query("UPDATE repos SET ai_summary=? WHERE id=? AND (ai_summary IS NULL OR ai_summary='')")
            .run(r.content.slice(0, 1200), id);
          log("info", `AI 对话 ${row.full_name}（${question.slice(0, 30)}）→ ${r.usage?.total_tokens || "?"} tokens`);
          return json({ ok: true, answer: r.content, usage: r.usage, model: r.model });
        } catch (e) {
          log("error", `AI 对话失败 ${row.full_name}：${e.message}`);
          return json({ error: e.message }, 502);
        }
      }

      const mReadme = p.match(/^\/api\/repo\/(\d+)\/readme$/);
      if (mReadme) {
        let row = db.query("SELECT * FROM repos WHERE id=?").get(Number(mReadme[1]));
        if (!row) {
          row = await adoptRepo(Number(mReadme[1]));
          if (!row) return json({ error: "not found" }, 404);
        }
        const md = await fetchReadme(row);
        return json({ id: row.id, markdown: md });
      }

      /* ---- 更新简介 / 备注 ---- */
      if (p === "/api/repo/update" && req.method === "POST") {
        const body = await req.json();
        if (typeof body.id !== "number") return json({ error: "bad id" }, 400);
        const sets = [], args = [];
        for (const k of Object.keys(body)) {
          if (UPDATABLE.has(k)) { sets.push(`${k}=?`); args.push(String(body[k] ?? "")); }
        }
        if (!sets.length) return json({ error: "无可更新字段" }, 400);
        // 只有真的改了 digest 才把来源标成 manual。改 note 顺带把 digest 标成 manual，
        // 会让下一次规则重算不再更新简介（等于悄悄冻结了自动简介）。
        if (sets.some((s) => s.startsWith("digest="))) sets.push("digest_src='manual'");
        args.push(body.id);
        db.query(`UPDATE repos SET ${sets.join(",")} WHERE id=?`).run(...args);
        return json({ ok: true });
      }

      /* ---- 标签 CRUD ---- */
      if (p === "/api/tags" && req.method === "GET")
        // 排序：先按父标签名（空的排最前），再按父标签自身 sort，子标签跟随父标签聚在一起
        return json(db.query(`
          SELECT t.* FROM tags t
          LEFT JOIN tags p ON p.name = t.parent
          ORDER BY COALESCE(t.parent,''), COALESCE(p.sort, t.sort), t.sort, t.name`).all());
      if (p === "/api/tags" && req.method === "POST") {
        const b = await req.json();
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "标签名为空" }, 400);
        const exist = db.query("SELECT * FROM tags WHERE name=?").get(name);
        if (exist) return json(exist);
        // parent：带父标签名就挂到它下面（两级分组），父标签不存在时静默忽略，
        // 否则一个拼错的父名会让整个创建请求失败，用户看不出原因。
        let parent = String(b.parent || "").trim() || null;
        if (parent && !db.query("SELECT id FROM tags WHERE name=?").get(parent)) parent = null;
        if (parent === name) parent = null;
        db.query("INSERT INTO tags (name, color, kind, parent) VALUES (?,?,?,?)")
          .run(name, b.color || null, b.kind || "manual", parent);
        return json(db.query("SELECT * FROM tags WHERE name=?").get(name));
      }
      const mTag = p.match(/^\/api\/tags\/(\d+)$/);
      if (mTag) {
        const id = Number(mTag[1]);
        if (req.method === "DELETE") {
          // 删父标签必须先把子标签的 parent 摘掉，否则子标签指向不存在的父级，
          // 侧栏分组里它们会整组消失（分组按 parent 名匹配）。
          const gone = db.query("SELECT name FROM tags WHERE id=?").get(id);
          db.query("DELETE FROM repo_tags WHERE tag_id=?").run(id);
          db.query("DELETE FROM tags WHERE id=?").run(id);
          if (gone?.name) db.query("UPDATE tags SET parent=NULL WHERE parent=?").run(gone.name);
          return json({ ok: true });
        }
        if (req.method === "PATCH") {
          const b = await req.json();
          const cur = db.query("SELECT name FROM tags WHERE id=?").get(id);
          // 改名必须级联子标签：parent 存的是名字，不一起改的话子标签会瞬间变成孤儿。
          if (b.name) {
            const nn = String(b.name).trim();
            if (nn && nn !== cur?.name) {
              db.query("UPDATE tags SET name=? WHERE id=?").run(nn, id);
              db.query("UPDATE tags SET parent=? WHERE parent=?").run(nn, cur?.name ?? "\u0000");
            }
          }
          if (b.color !== undefined) db.query("UPDATE tags SET color=? WHERE id=?").run(b.color, id);
          if (b.parent !== undefined) {
            // 允许置空（移回顶层）；不允许自己当自己的父标签
            const parent = String(b.parent || "").trim() || null;
            db.query("UPDATE tags SET parent=? WHERE id=?")
              .run(parent && parent !== cur?.name ? parent : null, id);
          }
          return json({ ok: true });
        }
      }
      if (p === "/api/repo/tag" && req.method === "POST") {
        const b = await req.json();
        const repoId = Number(b.repo_id);
        if (!repoId) return json({ error: "bad repo_id" }, 400);
        let tagId = Number(b.tag_id || 0);
        if (!tagId) {
          const name = String(b.name || "").trim();
          if (!name) return json({ error: "缺 tag_id 或 name" }, 400);
          tagId = tagByName(name).id;
        }
        if (b.action === "remove") {
          db.query("DELETE FROM repo_tags WHERE repo_id=? AND tag_id=?").run(repoId, tagId);
        } else {
          addRepoTag.run(repoId, tagId, "manual");
        }
        return json({ ok: true, tag_id: tagId });
      }

      /* ---- 收藏 / 取消收藏（真写 GitHub） ---- */
      if (p === "/api/star" && req.method === "POST") {
        const tkStar = currentToken();
        if (!tkStar) return json({ error: "未登录或未配置 token，无法写回 GitHub" }, 401);
        const b = await req.json();
        const row = db.query("SELECT * FROM repos WHERE id=?").get(Number(b.id));
        if (!row) return json({ error: "not found" }, 404);
        const url = `${GH}/user/starred/${row.full_name}`;
        const res = await fetch(url, {
          method: b.starred === false ? "DELETE" : "PUT",
          headers: {
            Authorization: `Bearer ${tkStar}`,
            "User-Agent": "open-source-radar",
            Accept: "application/vnd.github+json",
            "Content-Length": "0",
          },
        });
        log(res.ok ? "info" : "error", `${b.starred === false ? "取消 star" : "star"} ${row.full_name} → ${res.status}`);
        // 写回本地，别等下一轮同步：点完取消 star，列表里它就该立刻不是「我的收藏」；
        // 点回来也要能立刻撤销 detached，否则得等两小时才恢复。
        // 只对 source='starred' 生效——fork 不是 star 来的，取消 star 跟它没关系。
        if (res.ok && b.starred === false && row.source === "starred") {
          db.query("UPDATE repos SET detached=1, detached_at=? WHERE id=?").run(now(), row.id);
        } else if (res.ok && b.starred !== false && row.source === "starred") {
          db.query("UPDATE repos SET detached=0, detached_at=NULL WHERE id=?").run(row.id);
        }
        return json({ ok: res.ok, status: res.status });
      }

      /* ---- 隐藏 / 恢复 ---- */
      if (p === "/api/hide" && req.method === "POST") {
        const b = await req.json();
        const id = Number(b.id);
        // hidden.repo_id 是 INTEGER PRIMARY KEY（rowid 别名）。传脏值时 Number() 得 NaN，
        // SQLite 把 NaN 当成「未提供值」并自动分配 rowid —— 实测连发两次就凭空把
        // id=1、id=2 两个真实仓库隐藏掉。必须像 /api/repo/flag 一样先校验。
        if (!Number.isInteger(id) || id <= 0) return json({ error: "bad id" }, 400);
        if (b.hidden === false) db.query("DELETE FROM hidden WHERE repo_id=?").run(id);
        else db.query("INSERT OR IGNORE INTO hidden (repo_id, at) VALUES (?,?)").run(id, now());
        return json({ ok: true });
      }

      /* ---- 同步 ---- */
      if (p === "/api/sync" && req.method === "POST") {
        if (syncState.running) return json({ ok: true, ...syncState });
        const b = await req.json().catch(() => ({}));
        runSync(b.kind || "all");
        return json({ ok: true, started: true });
      }

      /* ---- 自动同步设置 ---- */
      if (p === "/api/settings/autosync") {
        if (req.method === "GET") {
          const { enabled, interval } = autoSyncConfig();
          return json({ enabled, interval, ...autoSyncRuntime(interval) });
        }
        if (req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          if (b.enabled !== undefined) setMeta("auto_sync_enabled", b.enabled ? "true" : "false");
          if (b.interval !== undefined) {
            const raw = Number(b.interval);
            if (!Number.isFinite(raw) || raw <= 0) return json({ error: "间隔必须是正数（分钟）" }, 400);
            // 越界不报错而是收敛，并如实回填——用户填 5 分钟要看到「已按 15 分钟执行」
            setMeta("auto_sync_interval", clampInterval(raw));
          }
          log("info", `自动同步设置已更新（${autoSyncConfig().enabled ? "开" : "关"} / ${humanInterval(autoSyncConfig().interval)}）`);
          scheduleAutoSync();     // 改完立刻重排，不用重启
          const { enabled, interval } = autoSyncConfig();
          return json({
            ok: true, enabled, interval,
            ...autoSyncRuntime(interval),
            next_run_at: enabled ? autoSyncRuntime(interval).next_run_at : null,
          });
        }
      }

      /* ---- 发现热门 ---- */
      // 默认阈值下发：前端开机取一次，之后用户输入什么就传什么。
      // 放在鉴权门内（和 /api/discover 同级），避免匿名探测。
      if (p === "/api/discover/defaults") {
        return json({ defaults: DISCOVER_DEFAULTS, note: DISCOVER_NOTE });
      }
      if (p === "/api/discover") {
        const qp = Object.fromEntries(u.searchParams);
        const out = await discover({
          sort: qp.sort || "stars",
          q: qp.q || "",
          // stars 不传时交给 discover 按榜单取默认，所以这里不要填 0
          stars: qp.stars === undefined || qp.stars === "" ? undefined : clampNum(qp.stars, 2000, 0, 5_000_000),
          days: qp.days === undefined || qp.days === "" ? undefined : clampNum(qp.days, 365, 1, 3650),
          // ?per_page=abc → Math.min(50, NaN) = NaN，会被原样拼进 GitHub 请求。
          page: clampNum(qp.page, 1, 1, 100),
          per_page: clampNum(qp.per_page, 30, 1, 50),
        });
        return json(out);
      }

      /* ---- 检查新版本 ---- */
      if (p === "/api/releases/check" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        // bun:sqlite 给 LIMIT ? 绑 NaN 会抛 datatype mismatch → 500。
        // 实测 null / undefined / 1.5 同样抛，只有整数安全，所以在入口收口。
        const lim = Math.min(100, Math.max(1, Math.trunc(Number(b.limit)) || 25));
        const r = await checkReleases(lim);
        return json({ ok: true, ...r });
      }

      /* ---- 列出有 release 的项目 ---- */
      if (p === "/api/releases")
        return json(db.query(`
          SELECT r.id, r.full_name, r.html_url, r.stars, r.topics, rel.tag, rel.name, rel.published_at, rel.url
          FROM releases rel JOIN repos r ON r.id=rel.repo_id
          ORDER BY rel.published_at DESC`).all());

      /* ---- 导出 / 导入 ---- */
      if (p === "/api/export") {
        const data = {
          exported_at: now(),
          tags: db.query("SELECT * FROM tags").all(),
          repos: db.query("SELECT * FROM repos").all().map((r) => ({ ...r, readme: undefined })),
          repo_tags: db.query("SELECT * FROM repo_tags").all(),
          hidden: db.query("SELECT * FROM hidden").all(),
          // AI 配置、自动同步设置、同步游标全在 meta 里。早先没导出它，
          // 「导出备份」恢复后 AI 要重配、自动同步要重开，等于备份少了一半。
          meta: db.query("SELECT k, v FROM meta WHERE k NOT LIKE 'ai_api_key%'").all()
            .reduce((o, r) => { o[r.k] = r.v; return o; }, {}),
        };
        return new Response(JSON.stringify(data, null, 1), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="radar-backup-${new Date().toISOString().slice(0, 10)}.json"`,
          },
        });
      }

      return json({ error: "unknown endpoint" }, 404);
    } catch (e) {
      log("error", `${p} → ${e.message}`);
      return json({ error: e.message }, 500);
    }
  },
});

log("info", `开源雷达启动 http://${HOST}:${PORT}  token=${currentToken() ? "yes" : "no"}`);
{
  const { enabled, interval } = autoSyncConfig();
  log("info", enabled
    ? `自动同步：开，每 ${humanInterval(interval)}（上次成功 ${getMeta("last_sync_ok") || "从未"}）`
    : "自动同步：关");
  scheduleAutoSync();
}

// 优雅退出：Docker 里 bun 是 PID 1，不处理 SIGTERM 会被 10 秒后 SIGKILL，
// WAL 文件残留、下次启动要重放恢复。这里关 SSE、停监听、checkpoint 后退出。
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `收到 ${sig}，正在关闭`);
  for (const send of listeners) {
    try { send({ type: "done", error: "服务正在关闭", running: false }); } catch {}
  }
  listeners.clear();
  try { server.stop(true); } catch {}
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
