/**
 * GitHub API 配额（rate limit）纯逻辑。
 *
 * 为什么要单独一层：GitHub 的配额是**按资源分别计数**的，`X-RateLimit-Resource`
 * 头说明了这次响应属于哪个桶（core 5000/小时、search 30/分钟、graphql 5000/小时…）。
 * 早先 server.mjs 用一个全局 `rate` 变量存最后一次响应的头，于是：
 *   · 搜索完再做一次 core 请求（同步、查 release、收编仓库），`/api/status` 报的就是
 *     core 的 5000，界面在「搜索配额」的位置显示 5000，属于谎报；
 *   · 反过来，core 操作后立刻搜一次，core 的余量又被打成 30。
 * 现在按 resource 分开存，谁问哪个桶就取哪个桶。
 */

/** 已知资源名。未知资源照样存（GitHub 加新桶时不至于崩），这里只用于文档。 */
export const KNOWN_RESOURCES = ["core", "search", "graphql", "integration_manifest"];

/** 从 fetch Response 的 headers 读配额；缺关键头时返回 null（304 与部分错误响应不带）。 */
export function readRate(headers, nowMs = Date.now()) {
  if (!headers || typeof headers.get !== "function") return null;
  const num = (k) => {
    const v = headers.get(k);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const limit = num("x-ratelimit-limit");
  const remaining = num("x-ratelimit-remaining");
  if (limit == null || remaining == null) return null;
  const resetSec = num("x-ratelimit-reset");
  const resource = headers.get("x-ratelimit-resource") || "core";
  return {
    resource,
    limit,
    remaining,
    // reset 是 Unix 秒；换成毫秒，null 表示这个响应没给（极少数情况）
    reset: resetSec == null ? null : resetSec * 1000,
    at: nowMs,
  };
}

/** 把一条配额记录并进桶表，返回新对象（不原地改，便于测试与快照）。 */
export function mergeRate(rates, entry) {
  if (!entry || !entry.resource) return rates || {};
  return { ...(rates || {}), [entry.resource]: entry };
}

/**
 * 取某个资源的当前配额，并处理「窗口已翻篇」。
 *
 * GitHub 的窗口按资源固定（search 每分钟、core 每小时），reset 过了余量就回满。
 * 不处理的话界面上会长期停着一个过期的数字——实测 reset 时刻已到，页面仍显示
 * 「搜索配额剩余 23」，实际那时已经回满 30，用户会误以为自己把配额用掉了一半。
 *
 * @returns {{resource,limit,remaining,reset,expired:boolean}|null}
 */
export function rateFor(rates, resource, nowMs = Date.now()) {
  const e = rates && rates[resource];
  if (!e) return null;
  if (e.reset != null && nowMs >= e.reset) {
    // 已翻篇：余量按「满」算，reset 清空（下一次真实响应会带回新的 reset）
    return { resource: e.resource, limit: e.limit, remaining: e.limit, reset: null, expired: true };
  }
  return { ...e, expired: false };
}

/** 界面上的一句话描述。remaining 未知时返回空串，调用方据此决定是否显示。 */
export function rateText(rate) {
  if (!rate || rate.remaining == null) return "";
  if (rate.expired) return "配额已重置";
  return rate.limit != null ? `配额 ${rate.remaining}/${rate.limit}` : `配额剩余 ${rate.remaining}`;
}
