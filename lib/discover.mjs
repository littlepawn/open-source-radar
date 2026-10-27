/* 发现页的搜索条件构建。
   抽成纯函数是为了能单测——拼 GitHub 搜索语法时，一个负号或引号就能把 query
   玩坏，而这条路径平时只在点「搜索」时才走，靠手点很难覆盖边界。 */

/** 各榜的默认阈值。
 *  分榜给不同默认值是有意为之：总 Star 榜门槛该高（不然老库全挤进来），
 *  最近活跃榜看的是「近期还有人推」，200 星就足够有意义。 */
export const DISCOVER_DEFAULTS = {
  stars: { stars: 2000, days: 365 },
  updated: { stars: 200, days: 90 },
};

export const DISCOVER_NOTE = "阈值可改：Star 门槛与「多少天内新建」都按输入的数值生效。";

/** 空 / 非数字回落 fallback；能解析的数字收进 [min, max]（越界是收敛，不是丢弃）。 */
export const MAX_QUERY_LEN = 512;
export function clampInt(v, fallback, min, max) {
  if (v === undefined || v === null || v === "") return fallback;
  // 只放行标量：Number([5]) === 5、Number(true) === 1、Number([]) === 0，
  // 数组/布尔不该被当成用户输入静默接受。
  if (typeof v !== "number" && typeof v !== "string") return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function sortKey(sort) {
  return sort === "updated" ? "updated" : "stars";
}

/**
 * 构建发现页真正发给 GitHub 的搜索串。
 * 优先用用户的自定义语法（此时 stars/days 不参与）；
 * 否则按「榜单默认值或用户输入」拼 stars:>N created:>DATE。
 * fork/archived 只在用户没自己写过时才补，不覆盖用户意图。
 */
export function buildDiscoverQuery({ sort, q, stars, days, now = Date.now() } = {}) {
  const key = sortKey(sort);
  // 兜底对齐前端（app.js 写 DISCOVER_DEFAULTS[k] || DISCOVER_DEFAULTS.stars）：
  // 新增榜单或改默认表时，后端没了兜底会直接 TypeError 变 500，前端却能降级。
  const def = DISCOVER_DEFAULTS[key] ?? DISCOVER_DEFAULTS.stars;
  const minStars = clampInt(stars, def.stars, 0, 5_000_000);
  const maxAge = clampInt(days, def.days, 1, 3650);

  // GitHub 搜索对 q 有长度上限，超长直接 422。stars/days 都 clamp 了，
  // q 不能是唯一零约束的口子——先收口，别把上游错误原样透给前端。
  let query = String(q ?? "").trim().slice(0, MAX_QUERY_LEN);
  if (!query) {
    const created = new Date(now - maxAge * 864e5).toISOString().slice(0, 10);
    query = `stars:>${minStars} created:>${created}`;
  }
  // GitHub 的搜索限定符本身大小写不敏感。用户写 Fork:true 时这里若检测不到，
  // 会再追加一个 fork:false，两个互斥条件一起发出去，结果为空或行为不确定。
  if (!/\bfork:/i.test(query)) query += " fork:false";
  if (!/\barchived:/i.test(query)) query += " archived:false";

  // sortKey() 的返回域就是 "stars" | "updated"，与 sortField 完全等价，
  // 再写一遍三元只会让两者日后脱节。
  return { query, minStars, maxAge, sortField: key };
}
