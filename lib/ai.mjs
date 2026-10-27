/* 仓库分析：把仓库数据压成适合丢给大模型的上下文，并内置分析提示词。
   纯函数，不发请求——请求在 server.mjs 里，方便 mock 测试。 */

/** 粗略 token 估算：中文 ~1.5 字/token，英文 ~4 字符/token。只用做截断预算。 */
export function estimateTokens(s) {
  const str = String(s || "");
  let cjk = 0;
  for (const ch of str) if (/[\u4e00-\u9fa5\u3040-\u30ff]/.test(ch)) cjk++;
  const rest = str.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

/** 按预算从尾部截断（README 开头信息密度最高，所以保留头部） */
export function clip(text, maxTokens) {
  const s = String(text || "");
  if (estimateTokens(s) <= maxTokens) return { text: s, truncated: false };
  // 反复二分收敛，避免一次性估偏
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid; else hi = mid - 1;
  }
  return { text: s.slice(0, lo), truncated: true };
}

/** 从文件树里挑出「能说明技术栈」的关键文件，按优先级排序 */
export const KEY_FILES = [
  "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml",
  "pom.xml", "build.gradle", "composer.json", "Gemfile", "Dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "Makefile",
  "README.md", "README.zh-CN.md", "README_CN.md",
];

export function pickKeyFiles(tree = [], limit = 12) {
  const paths = tree.filter((p) => typeof p === "string");
  const chosen = [];
  for (const kf of KEY_FILES) {
    // 根目录优先
    if (paths.includes(kf)) chosen.push(kf);
  }
  for (const kf of KEY_FILES) {
    if (chosen.includes(kf)) continue;
    const hit = paths.find((p) => p !== kf && p.endsWith("/" + kf));
    if (hit && !chosen.includes(hit)) chosen.push(hit);
  }
  return chosen.slice(0, limit);
}

/** 顶层目录概览，比逐个文件路径更能说明项目结构 */
export function topDirs(tree = [], limit = 20) {
  // 只统计「作为目录出现过」的顶层名：树里某条路径形如 name/... 才算目录。
  // 早先用「名字里有没有点」判断，LICENSE、Makefile、Dockerfile 这类无扩展名文件
  // 会被当成目录混进目录列表（实测把 LICENSE 和 Dockerfile 都列了出来）。
  const seen = new Set();
  for (const p of tree) {
    if (typeof p !== "string") continue;
    const i = p.indexOf("/");
    if (i <= 0) continue;                       // 没有斜杠 = 根目录文件，不算目录
    const first = p.slice(0, i);
    if (first === "." || first === "..") continue;
    seen.add(first);
    if (seen.size >= limit) break;
  }
  return [...seen].slice(0, limit);
}

export const SYSTEM_PROMPT = `你是资深开源项目分析助手，服务对象是一位中文开发者。他本地有个 GitHub 收藏看板，会就单个仓库向你提问。

回答原则：
1. 只基于给定的仓库数据和你的通用知识回答，不要编造该仓库里不存在的功能、API 或文件。
2. 不确定就直说不确定，并指出需要看哪个文件/目录才能确认。
3. 用简体中文，简洁分点，不写客套话。
4. 用户问「这个项目是什么」时，按这个顺序讲：一句话定位 → 解决什么问题 → 技术栈 → 成熟度（star/活跃度/是否归档）→ 值得注意的坑。
5. 用户问「能不能用于 X」时，先判断能力边界，再给接入方式，最后指出风险。
6. 不要在回答里贴整段 README 原文，要提炼。`;

/**
 * 构建对话消息。
 * @param {object} repo 仓库行（含 full_name/description/digest/topics/tags/stars/...）
 * @param {Array<{role:string, content:string}>} history 历史消息
 * @param {string} question 本轮问题
 * @param {{readme?:string, tree?:string[], files?:Record<string,string>, budget?:number}} ctx
 */
export function buildMessages(repo, history, question, ctx = {}) {
  const budget = ctx.budget ?? 6000;
  const topics = Array.isArray(repo.topics)
    ? repo.topics
    : (() => { try { const a = JSON.parse(repo.topics || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })();

  const facts = [
    `仓库：${repo.full_name}`,
    repo.description ? `官方描述：${repo.description}` : "",
    repo.digest ? `本地中文简介：${repo.digest.replace(/\n/g, " ")}` : "",
    topics.length ? `Topics：${topics.join(", ")}` : "",
    (repo.tags || []).length ? `我的标签：${repo.tags.join(", ")}` : "",
    `语言：${repo.language || "未知"} · Star ${repo.stars ?? 0} · Fork ${repo.forks ?? 0}`,
    `创建 ${String(repo.created_at || "").slice(0, 10)} · 最后推送 ${String(repo.pushed_at || "").slice(0, 10)}`,
    repo.license ? `协议：${repo.license}` : "",
    repo.archived ? "状态：上游已归档" : "",
    repo.source === "fork" ? `这是我从 ${repo.upstream || "上游"} fork 的仓库` : "",
    repo.note ? `我的备注：${repo.note}` : "",
  ].filter(Boolean).join("\n");

  const parts = [`## 仓库数据\n${facts}`];

  if (ctx.tree?.length) {
    const dirs = topDirs(ctx.tree);
    const keys = pickKeyFiles(ctx.tree);
    parts.push(
      `## 目录结构（节选）\n${dirs.join(", ")}` +
      (keys.length ? `\n关键文件：${keys.join(", ")}` : "")
    );
  }
  if (ctx.readme) {
    const { text, truncated } = clip(ctx.readme, Math.max(800, Math.floor(budget * 0.55)));
    parts.push(`## README${truncated ? "（已截断）" : ""}\n${text}`);
  }
  if (ctx.files && Object.keys(ctx.files).length) {
    const room = Math.max(400, Math.floor(budget * 0.25) - estimateTokens(facts));
    const chunks = [];
    for (const [p, content] of Object.entries(ctx.files)) {
      const c = clip(content, Math.max(200, Math.floor(room / Object.keys(ctx.files).length)));
      chunks.push(`### ${p}\n${c.text}${c.truncated ? "\n…（截断）" : ""}`);
    }
    parts.push(`## 关键文件内容\n${chunks.join("\n\n")}`);
  }

  // extraPrompt：用户在「AI 设置」里追加的长期要求（如「回答控制在三句话内」）。
  // 拼在系统提示末尾而不是仓库数据前面，避免它的措辞被 facts 里的内容稀释。
  const extra = String(ctx.extraPrompt || "").trim();
  const sys = `${SYSTEM_PROMPT}${extra ? `\n\n## 用户额外要求\n${extra}` : ""}\n\n${parts.join("\n\n")}`;
  const msgs = [{ role: "system", content: sys }];
  for (const h of history || []) {
    if (h?.role === "user" || h?.role === "assistant") {
      msgs.push({ role: h.role, content: String(h.content || "") });
    }
  }
  msgs.push({ role: "user", content: String(question || "").trim() });
  return msgs;
}

/** 常见接入方式的默认 baseURL / 模型，供前端一键填充（字段名用 base_url，与配置接口一致） */
export const AI_PRESETS = [
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "moonshot", label: "Moonshot / Kimi", base_url: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "zhipu", label: "智谱 GLM", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { id: "dashscope", label: "通义千问", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "ollama", label: "Ollama（本地）", base_url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" },
  { id: "custom", label: "自定义 / 中转", base_url: "", model: "" },
];

/** 校验配置，返回错误信息数组（空数组=通过） */
export function validateAiConfig(cfg) {
  const errs = [];
  const base = String(cfg?.base_url || "").trim();
  const model = String(cfg?.model || "").trim();
  if (!base) errs.push("base_url 不能为空");
  else if (!/^https?:\/\//i.test(base)) errs.push("base_url 必须以 http:// 或 https:// 开头");
  if (!model) errs.push("model 不能为空");
  if (!Number.isFinite(cfg?.max_tokens) || cfg.max_tokens <= 0) errs.push("max_tokens 必须是正整数");
  else if (cfg.max_tokens > 32000) errs.push("max_tokens 过大，建议不超过 32000");
  if (cfg?.temperature != null) {
    if (!Number.isFinite(cfg.temperature) || cfg.temperature < 0 || cfg.temperature > 2) {
      errs.push("temperature 需在 0–2 之间");
    }
  }
  return errs;
}
