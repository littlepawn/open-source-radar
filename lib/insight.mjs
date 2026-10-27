/* 评分与洞察的纯逻辑：停滞、清理候选、fork 落后、相似度。
   全部无副作用、无 db 依赖，方便 bun test 直接测。 */

const DAY = 86400000;

const daysBetween = (iso, nowMs) => {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return null;
  return Math.floor((nowMs - t) / DAY);
};

/**
 * 停滞判定：收藏很久但上游一直没动。
 * 判据是可解释的，不做黑箱打分——用户要能看懂为什么被标成「停滞」。
 * @param {{pushed_at?:string, archived?:number, stars?:number}} r
 * @param {number} nowMs
 * @param {{idleDays?:number}} [opt]
 */
export function stagnation(r, nowMs = Date.now(), opt = {}) {
  const idleDays = opt.idleDays ?? 180;
  const pushedAgo = daysBetween(r.pushed_at, nowMs);
  const archived = !!r.archived;
  if (archived) return { stale: true, reason: "上游已归档", pushedAgo };
  if (pushedAgo == null) return { stale: false, reason: "无推送时间", pushedAgo: null };
  if (pushedAgo >= idleDays) return { stale: true, reason: `${pushedAgo} 天未推送`, pushedAgo };
  return { stale: false, reason: `${pushedAgo} 天内活跃`, pushedAgo };
}

/**
 * 清理候选：四条独立信号，命中任意两条才进候选，避免单信号误杀。
 * 只产出清单，绝不自动取消 star。
 */
export function cleanupCandidates(rows, nowMs = Date.now(), opt = {}) {
  const idleDays = opt.idleDays ?? 365;
  const neverOpenedDays = opt.neverOpenedDays ?? 180;
  const out = [];
  for (const r of rows) {
    const signals = [];
    if (r.archived) signals.push("上游已归档");
    const pushedAgo = daysBetween(r.pushed_at, nowMs);
    if (pushedAgo != null && pushedAgo >= idleDays) signals.push(`上游 ${pushedAgo} 天没推送`);
    // open_count 为 0 且收藏超过 N 天 = 收了就没看过
    const starredAgo = daysBetween(r.starred_at, nowMs);
    if (!r.open_count && starredAgo != null && starredAgo >= neverOpenedDays) {
      signals.push(`收藏 ${starredAgo} 天从未打开`);
    }
    if (r.dropped) signals.push("已标记放弃");
    if (signals.length >= 2) out.push({ id: r.id, full_name: r.full_name, signals });
  }
  return out;
}

/**
 * fork 落后上游多少 commit。
 * GitHub compare 返回 ahead_by / behind_by；这里只做字段提取与兜底，
 * 不在这里发请求。
 * @returns {{behind:number|null, ahead:number|null, status:string}}
 */
export function forkLag(compare) {
  if (!compare || typeof compare !== "object") {
    return { behind: null, ahead: null, status: "unknown" };
  }
  // compare 对完全不相关的历史会报 404，调用方传 null 进来
  const behind = Number.isFinite(compare.behind_by) ? compare.behind_by : null;
  const ahead = Number.isFinite(compare.ahead_by) ? compare.ahead_by : null;
  if (behind === null && ahead === null) return { behind: null, ahead: null, status: "unknown" };
  if (behind === 0 && ahead === 0) return { behind: 0, ahead: 0, status: "identical" };
  if (behind > 0 && !ahead) return { behind, ahead: ahead ?? 0, status: "behind" };
  if (ahead > 0 && !behind) return { behind: behind ?? 0, ahead, status: "ahead" };
  return { behind, ahead, status: "diverged" };
}

/** fork 落后的人话说明，放在卡片角标上 */
export function forkLagText(lag) {
  if (!lag || lag.status === "unknown" || lag.behind === null) return "";
  if (lag.status === "identical") return "与上游一致";
  if (lag.status === "behind") return `落后上游 ${lag.behind}`;
  if (lag.status === "ahead") return `领先上游 ${lag.ahead}`;
  return `落后 ${lag.behind} / 领先 ${lag.ahead}`;
}

/**
 * 相似仓库：topics 与标签的加权 Jaccard。
 * topics 覆盖率高但噪音大；标签是人工/规则产出的，权重给高一点。
 */
// topics 在库里是 JSON 字符串（repos.topics），传进来时也可能是数组。
// 统一在库层面兼容两种形态，调用方就不用每次手动 JSON.parse —— 少一处就容易漏一处。
const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const a = JSON.parse(v);
      if (Array.isArray(a)) return a;
    } catch {}
    return v.split(/[,\s]+/).filter(Boolean);
  }
  return [];
};

export function similarity(a, b, opt = {}) {
  const wTopic = opt.wTopic ?? 1;
  const wTag = opt.wTag ?? 2;
  const wLang = opt.wLang ?? 0.5;
  const aT = new Set(asList(a.topics).map((s) => String(s).toLowerCase()));
  const bT = new Set(asList(b.topics).map((s) => String(s).toLowerCase()));
  const aG = new Set(a.tags || []);
  const bG = new Set(b.tags || []);

  const jaccard = (x, y) => {
    if (!x.size && !y.size) return 0;
    let inter = 0;
    for (const v of x) if (y.has(v)) inter++;
    return inter / (x.size + y.size - inter);
  };

  let score = wTopic * jaccard(aT, bT) + wTag * jaccard(aG, bG);
  if (a.language && b.language && a.language === b.language) score += wLang;
  // 同一作者的项目高度相关，给一点加成但不喧宾夺主
  if (a.owner && b.owner && a.owner === b.owner) score += 0.5;
  return Math.round(score * 1000) / 1000;
}

/** 给某个仓库找最相似的 N 个 */
export function similarTo(target, rows, limit = 5) {
  return rows
    .filter((r) => r.id !== target.id)
    .map((r) => ({ id: r.id, full_name: r.full_name, score: similarity(target, r) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.full_name.localeCompare(b.full_name))
    .slice(0, limit);
}
