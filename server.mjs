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
// 轻量迁移：老库补列
for (const [col, ddl] of [["upstream", "ALTER TABLE repos ADD COLUMN upstream TEXT"]]) {
  const cols = db.query("PRAGMA table_info(repos)").all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(ddl);
}
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
  if (Number(row.exp) < Date.now()) {
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


/* ---------------------------------------------------------------- GitHub 客户端 */
let rate = { limit: null, remaining: null, reset: null, resource: null };
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
      res = await fetch(url, { headers });
    } catch (e) {
      if (attempt === retry) throw new Error(`网络错误 ${url}: ${e.message}`);
      await sleep(800 * (attempt + 1));
      continue;
    }
    const rl = (n) => res.headers.get(`x-ratelimit-${n}`);
    if (rl("limit")) {
      rate = {
        limit: Number(rl("limit")),
        remaining: Number(rl("remaining")),
        reset: rl("reset") ? Number(rl("reset")) * 1000 : null,
        resource: rl("resource"),
      };
    }
    if (res.status === 304) return { notModified: true };
    if (res.ok) {
      const remaining = Number(rl("remaining") ?? 1);
      const isSearch = url.includes("/search/");
      // 配额将尽时要在「下次请求」前等，而不是扔掉这次已经成功拿到的响应再重发：
      // 搜索结果是分页的，重发会得到不同 offset 的内容，丢页比等待更糟。
      const data = await res.json();
      if (remaining <= 2 && rate.reset && isSearch) {
        const wait = Math.max(0, rate.reset - Date.now());
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
      const wait = rate.reset ? Math.max(1000, rate.reset - Date.now()) : 60000;
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
const RULES = [
  // [正则, 中文场景短语, 兜底标签]
  [/ppt|slide|presentation|keynote|powerpoint/i, "做 PPT / 演示文稿（AI 直接把文档或主题生成可编辑的演示稿）", "文档办公"],
  [/excel|spreadsheet|xlsx|office|docx|\bword\b/i, "文档 / 表格处理，本地读写 Office 文件", "文档办公"],
  [/pdf/i, "PDF 解析、转换与批注处理", "文档办公"],
  [/\bnotes?\b|obsidian|markdown|wiki|notion|knowledge|second[- ]?brain/i, "笔记 / 知识库与 Markdown 写作管理", "知识管理"],
  [/agent|autogpt|crew|langgraph|autogen/i, "AI Agent 框架，把大模型串成能自己干活的流程", "AI / Agent"],
  [/llm|gpt|chatgpt|claude|qwen|deepseek|gemini|inference|vllm|ollama/i, "大模型推理 / 本地跑模型 / 模型服务", "AI / 大模型"],
  [/\brag\b|ragflow|embedding|vector|pinecone|milvus|chroma|faiss/i, "向量检索与 RAG 知识库，让模型查自己的资料", "RAG / 向量库"],
  [/diffusion|stable[- ]?diffusion|image[- ]?gen|comfyui|\bflux\b|sdxl|midjourney/i, "AI 文生图 / 图像生成与工作流", "AI 绘图"],
  [/\btts\b|\bvoice\b|speech|whisper|\baudio\b|\basr\b|\bmusic\b|\bsing\b|sing-box/i, "语音合成 / 语音识别 / 音频处理", "音频语音"],
  [/video|ffmpeg|subtitle|animation|remotion|剪辑|剪映/i, "视频处理、字幕与自动剪辑", "视频处理"],
  [/docker|kubernetes|k8s|helm|compose|container/i, "容器与容器编排，部署运维基础设施", "容器 / 运维"],
  [/nginx|proxy|reverse|tunnel|frp|wireguard|vpn|clash|sing-?box|v2ray|xray/i, "网络代理 / 内网穿透 / 反向代理", "网络代理"],
  [/monitor|prometheus|grafana|observab|uptime[- _]?monitor|alertmanager/i, "监控告警、指标采集与日志观察", "监控运维"],
  [/\bnas\b|home[- ]?assistant|homelab|self[- ]?host|dashboard|unraid/i, "自托管 / 家庭服务器 / NAS 面板类工具", "自托管"],
  [/scrap|crawl|spider|puppeteer|playwright|selenium|browser/i, "网页抓取与浏览器自动化", "爬虫自动化"],
  [/chrome|extension|userscript|tampermonkey|油猴/i, "浏览器扩展 / 油猴脚本，网页增强", "浏览器扩展"],
  [/macos|swiftui|\bios\b|iphone|uikit|app store/i, "Apple 平台（macOS / iOS）应用或工具", "Apple 生态"],
  [/\bmagisk\b|\bxposed\b|\bfrida\b|刷机|免root|root权限|android.*(逆向|破解|改机|去广告|脱壳|hook|magisk|xposed|frida|adb shell|root)|\badb\b.*(shell|push|pull|fastboot|设备|device)/i, "安卓系统改造、免 root / root 工具链", "安卓逆向"],
  [/decompil|disassembl|ghidra|\bida\b|kernel exploit|\bpwn\b|reversing|逆向/i, "逆向工程 / 二进制分析与漏洞研究", "逆向分析"],
  [/crypto|bitcoin|ethereum|blockchain|web3|钱包|wallet/i, "区块链 / 加密钱包相关", "区块链"],
  [/sql|database|postgres|mysql|sqlite|redis|mongo|\borm\b/i, "数据库与数据存储层的工具/客户端", "数据库"],
  [/terminal|\bshell\b|\bcli\b|\btui\b|command[- ]line/i, "命令行 / TUI 终端增强工具", "命令行工具"],
  [/editor|vim|neovim|emacs|\bide\b|code[- ]?editor/i, "代码编辑器 / 开发环境", "编辑器 IDE"],
  [/(?<![a-z0-9-])ui\b(?![-.])|component|tailwind|\breact\b|\bvue\b|svelte|frontend|\bcss\b|design system/i, "前端 UI 组件库 / 设计系统", "前端 UI"],
  [/\be2e\b|cypress|jest|vitest|test-framework|testing-framework/i, "测试框架与质量保障", "测试工程"],
  [/\bci\b|continuous (delivery|integration)|pipeline|github action|devops|ci\/cd/i, "CI/CD 与自动化部署流程", "CI/CD"],
  [/security|exploit|vulnerab|\bcve\b|pentest|malware|\bav\b|免杀|\bhack(ing|er)?\b|hackthebox|渗透|漏洞/i, "安全攻防 / 漏洞利用 / 恶意样本研究", "安全攻防"],
  [/game|emulator|retro|steam|游戏/i, "游戏相关工具 / 模拟器 / 游戏资源", "游戏"],
  [/download|magnet|torrent|\bbt\b|网盘|baidu|onedrive|aliyun/i, "下载 / 网盘 / 磁力资源管理", "下载网盘"],
  [/translate|i18n|字幕|translat/i, "翻译与多语言支持", "翻译"],
  [/\bpdf\b|\bocr\b|\bscan(n(ing|er))?\b|文字识别|识别文字/i, "OCR 文字识别与扫描件解析", "OCR"],
  [/proxy|中转|forward/i, "API 转发与请求中转", "中转转发"],
];

function ruleDigest(r) {
  const hay = [r.description, (r.topics || []).join(" "), r.name, r.language].filter(Boolean).join(" ");
  const hits = [];
  for (const [re, sentence, tag] of RULES) if (re.test(hay)) hits.push({ sentence, tag });
  const tagSet = [...new Set(hits.map((h) => h.tag))].slice(0, 3);
  const sentences = hits.slice(0, 2).map((h) => h.sentence);
  const zh = (r.description || "").trim();
  const hasCJK = /[\u4e00-\u9fa5]/.test(zh);
  const head = sentences.length
    ? (hasCJK ? `【${tagSet.join(" / ")}】${zh.slice(0, 130)}` : sentences.join("；") + "。")
    : zh
      ? "用途：" + zh.slice(0, 120) + (zh.length > 120 ? "…" : "")
      : "暂无描述，点开右侧 README 看原文。";
  const tail = `${r.language || "未知语言"} · ⭐ ${fmt(r.stars)} · 最后推送 ${(r.pushed_at || "").slice(0, 10)}`;
  return { digest: `${head}\n${tail}`, tags: tagSet };
}
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n ?? 0));

/* ---------------------------------------------------------------- 入库 */
const upsertRepo = db.prepare(`
INSERT INTO repos (id, full_name, owner, name, html_url, description, homepage, language, topics,
  stars, forks, issues, watchers, size_kb, license, archived, is_fork, created_at, pushed_at,
  starred_at, source, fetched_at)
VALUES ($id,$full_name,$owner,$name,$html_url,$description,$homepage,$language,$topics,
  $stars,$forks,$issues,$watchers,$size_kb,$license,$archived,$is_fork,$created_at,$pushed_at,
  $starred_at,$source,$fetched_at)
ON CONFLICT(id) DO UPDATE SET
  full_name=excluded.full_name, owner=excluded.owner, name=excluded.name,
  html_url=excluded.html_url, description=excluded.description, homepage=excluded.homepage,
  language=excluded.language, topics=excluded.topics, stars=excluded.stars, forks=excluded.forks,
  issues=excluded.issues, watchers=excluded.watchers, size_kb=excluded.size_kb,
  license=excluded.license, archived=excluded.archived, is_fork=excluded.is_fork,
  created_at=excluded.created_at, pushed_at=excluded.pushed_at,
  starred_at=COALESCE(excluded.starred_at, repos.starred_at),
  source=excluded.source, fetched_at=excluded.fetched_at
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
    fetched_at: now(),
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
const listeners = new Set();
function broadcast(obj) {
  db.query("DELETE FROM events WHERE id <= (SELECT MAX(id)-2000 FROM events)").run();
  for (const fn of listeners) {
    try { fn(obj); } catch {}
  }
}
db.query("DELETE FROM events WHERE id <= (SELECT MAX(id)-2000 FROM events)").run();

class StopPaging extends Error {}

async function syncStarred({ incremental = true } = {}) {
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
  return count;
}
async function syncForks() {
  syncState.phase = "拉取 fork";
  const me = await gh("/user");
  if (me.notFound) throw new Error("无法读取 /user，token 是否有效？");
  const login = me.login;
  const data = await gh(`/users/${login}/repos?type=owner&affiliation=owner&per_page=100&sort=updated`);
  if (!Array.isArray(data)) throw new Error("读取自己的仓库失败");
  let forks = data.filter((r) => r.fork);
  let page = 2;
  // 分页补全
  while (data.length === 100 || forks.length) {
    if (page > 20) break;
    const more = await gh(`/users/${login}/repos?type=owner&per_page=100&sort=updated&page=${page}`);
    if (!Array.isArray(more) || more.length === 0) break;
    forks = forks.concat(more.filter((r) => r.fork));
    if (more.length < 100) break;
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
  return { count, login };
}

async function runSync(kind = "all") {
  if (syncState.running) return syncState;
  syncState = { running: true, kind, total: 0, done: 0, started_at: now(), error: null, phase: "启动" };
  broadcast({ type: "progress", ...syncState });
  let stars = 0, forks = 0;
  let t0 = Date.now();
  try {
    if (kind === "all" || kind === "starred") {
      stars = await syncStarred();
      setMeta("stars_synced_at", now());
      if (!LOGIN()) setMeta("login", process.env.RADAR_LOGIN || "");
    }
    if (kind === "all" || kind === "fork") {
      const r = await syncForks();
      forks = r.count;
      setMeta("forks_synced_at", now());
      setMeta("login", r.login);
    }
    setMeta("last_sync_ok", now());
    log("info", `同步完成：star ${stars}，fork ${forks}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    syncState.error = e.message;
    log("error", `同步失败：${e.message}`);
  } finally {
    syncState = { ...syncState, running: false, phase: "结束" };
    broadcast({ type: "done", ...syncState });
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
  const res = await fetch(`${GH}/repos/${row.full_name}/readme`, { headers });
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`README 获取失败 ${res.status}`);
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

async function discover({ sort = "stars", q = "", days = 365, per_page = 30, page = 1 } = {}) {
  let query = q.trim();
  if (!query) {
    const created = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    query = `stars:>${sort === "stars" ? 2000 : 200} created:>${created}`;
  }
  if (!/\bfork:/.test(query)) query += " fork:false";
  if (!/\barchived:/.test(query)) query += " archived:false";
  const sortField = sort === "updated" ? "updated" : "stars";
  const data = await gh(`/search/repositories?q=${encodeURIComponent(query)}&sort=${sortField}&order=desc&per_page=${per_page}&page=${page}`);
  if (data.notFound) return { items: [], total: 0, query };
  const items = (data.items || []).filter((r) => {
    const hay = `${r.full_name} ${r.description || ""} ${(r.topics || []).join(" ")}`;
    return !CN_BLOCK.test(hay);
  });
  return {
    total: data.total_count || 0,
    query,
    rate,
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
        WHERE source='starred' AND archived=0
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
  "app.css", "app.js", "favicon.ico",
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

const UPDATABLE = new Set(["digest", "homepage"]);

function repoList({ q = "", source = "", tag = "", lang = "", sort = "stars", scope = "all", limit = 5000 }) {
  // limit 来自查询参数，直接拼进 SQL 会得到 LIMIT NaN（实测 500 no such column: NaN），
  // 超大值还会拖出全表。收敛成 1..2000 的有限整数。
  limit = Math.min(2000, Math.max(1, Math.trunc(Number(limit)) || 500));
  const where = [];
  const args = [];
  // hidden 谓词按 scope/source 组合显式构造。曾用 where[indexOf(...)] 改写，
  // scope=hidden 时那项根本没 push，indexOf 返回 -1 → where[-1]=... 无效，
  // 隐藏过滤消失，scope=hidden 会返回全部仓库（实测 226 条）。
  const wantHidden = scope === "hidden" || source === "hidden";
  where.push(wantHidden ? "h.repo_id IS NOT NULL" : "h.repo_id IS NULL");
  if (source === "starred" || source === "fork" || source === "discover") {
    where.push("r.source = ?"); args.push(source);
  } else if (!wantHidden) {
    // 默认「全部」视图不掺发现页收编的临时仓库，只在我明确点「发现过的」时出现
    where.push("r.source != 'discover'");
  }
  if (lang) { where.push("r.language = ?"); args.push(lang); }
  if (tag) {
    where.push("r.id IN (SELECT rt.repo_id FROM repo_tags rt JOIN tags t ON t.id=rt.tag_id WHERE t.name=?)");
    args.push(tag);
  }
  if (q.trim()) {
    where.push("(r.full_name LIKE ? OR r.description LIKE ? OR r.digest LIKE ? OR r.topics LIKE ?)");
    const like = `%${q.trim()}%`;
    args.push(like, like, like, like);
  }
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
          const send = (o) => { if (!closed) { try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch {} } };
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
        const counts = db.query(`
          SELECT source, COUNT(*) n FROM repos
          WHERE id NOT IN (SELECT repo_id FROM hidden) GROUP BY source`).all();
        const bySource = Object.fromEntries(counts.map((c) => [c.source, c.n]));
        // 侧栏「已隐藏」的计数：前端一直在读 counts.hidden，服务端却没给过
        bySource.hidden = db.query("SELECT COUNT(*) n FROM hidden").get()?.n || 0;
        const tags = db.query(`
          SELECT t.id, t.name, t.kind, t.color, COUNT(rt.repo_id) n
          FROM tags t LEFT JOIN repo_tags rt ON rt.tag_id=t.id
          GROUP BY t.id ORDER BY n DESC, t.name`).all();
        const langs = db.query(`
          SELECT language, COUNT(*) n FROM repos
          WHERE language != '' AND id NOT IN (SELECT repo_id FROM hidden)
          GROUP BY language ORDER BY n DESC LIMIT 40`).all();
        return json({
          login: getMeta("login"),
          authed: !!sessionInfo(req),
          token_source: ENV_TOKEN ? "env" : runtimeToken ? "login" : "none",
          token: currentToken() ? "已配置" : "未配置（匿名 60 次/小时）",
          rate,
          counts: { starred: bySource.starred || 0, fork: bySource.fork || 0, discover: bySource.discover || 0, hidden: bySource.hidden || 0 },
          stars_synced_at: getMeta("stars_synced_at"),
          forks_synced_at: getMeta("forks_synced_at"),
          releases_checked_at: getMeta("releases_checked_at"),
          sync: syncState,
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
        return json({ ...row, tags: (db.query(
          "SELECT t.name, t.kind FROM repo_tags rt JOIN tags t ON t.id=rt.tag_id WHERE rt.repo_id=?", ).all(id)) });
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

      /* ---- 更新简介 ---- */
      if (p === "/api/repo/update" && req.method === "POST") {
        const body = await req.json();
        if (typeof body.id !== "number") return json({ error: "bad id" }, 400);
        const sets = [], args = [];
        for (const k of Object.keys(body)) {
          if (UPDATABLE.has(k)) { sets.push(`${k}=?`); args.push(String(body[k] ?? "")); }
        }
        if (!sets.length) return json({ error: "无可更新字段" }, 400);
        sets.push("digest_src='manual'");
        args.push(body.id);
        db.query(`UPDATE repos SET ${sets.join(",")} WHERE id=?`).run(...args);
        return json({ ok: true });
      }

      /* ---- 标签 CRUD ---- */
      if (p === "/api/tags" && req.method === "GET")
        return json(db.query("SELECT * FROM tags ORDER BY sort, name").all());
      if (p === "/api/tags" && req.method === "POST") {
        const b = await req.json();
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "标签名为空" }, 400);
        const exist = db.query("SELECT * FROM tags WHERE name=?").get(name);
        if (exist) return json(exist);
        db.query("INSERT INTO tags (name, color, kind) VALUES (?,?,?)").run(name, b.color || null, b.kind || "manual");
        return json(db.query("SELECT * FROM tags WHERE name=?").get(name));
      }
      const mTag = p.match(/^\/api\/tags\/(\d+)$/);
      if (mTag) {
        const id = Number(mTag[1]);
        if (req.method === "DELETE") {
          db.query("DELETE FROM repo_tags WHERE tag_id=?").run(id);
          db.query("DELETE FROM tags WHERE id=?").run(id);
          return json({ ok: true });
        }
        if (req.method === "PATCH") {
          const b = await req.json();
          if (b.name) db.query("UPDATE tags SET name=? WHERE id=?").run(String(b.name).trim(), id);
          if (b.color !== undefined) db.query("UPDATE tags SET color=? WHERE id=?").run(b.color, id);
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
        return json({ ok: res.ok, status: res.status });
      }

      /* ---- 隐藏 / 恢复 ---- */
      if (p === "/api/hide" && req.method === "POST") {
        const b = await req.json();
        const id = Number(b.id);
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

      /* ---- 发现热门 ---- */
      if (p === "/api/discover") {
        const qp = Object.fromEntries(u.searchParams);
        const out = await discover({
          sort: qp.sort || "stars",
          q: qp.q || "",
          days: Number(qp.days || 365),
          page: Number(qp.page || 1),
          per_page: Math.min(50, Number(qp.per_page || 30)),
        });
        return json(out);
      }

      /* ---- 检查新版本 ---- */
      if (p === "/api/releases/check" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const r = await checkReleases(Number(b.limit || 25));
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
