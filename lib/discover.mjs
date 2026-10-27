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

/** 把前端传来的数字收进合法区间；空 / 非数字 / 越界一律回落到 fallback。 */
export function clampInt(v, fallback, min, max) {
  if (v === undefined || v === null || v === "") return fallback;
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
  const def = DISCOVER_DEFAULTS[key];
  const minStars = clampInt(stars, def.stars, 0, 5_000_000);
  const maxAge = clampInt(days, def.days, 1, 3650);

  let query = String(q ?? "").trim();
  if (!query) {
    const created = new Date(now - maxAge * 864e5).toISOString().slice(0, 10);
    query = `stars:>${minStars} created:>${created}`;
  }
  if (!/\bfork:/.test(query)) query += " fork:false";
  if (!/\barchived:/.test(query)) query += " archived:false";

  return { query, minStars, maxAge, sortField: key === "updated" ? "updated" : "stars" };
}
