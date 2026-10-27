/* 自动同步的时间计算。纯函数，不碰定时器也不碰数据库——
   定时器在 server.mjs 里，这里只负责「下次该在什么时候跑」。
   单独抽出来的原因：时间边界（错过、跨天、非法值）最容易出 bug，
   而这些 bug 只能靠单测发现，等真跑到点上才暴露就太晚了。 */

/** 默认两小时一次。下限 15 分钟：GitHub 未认证配额 60 次/小时，
    一次全量同步要翻页几十次，间隔太短会把自己的配额打光。 */
export const DEFAULT_INTERVAL_MIN = 120;
export const MIN_INTERVAL_MIN = 15;
export const MAX_INTERVAL_MIN = 24 * 60;

/**
 * 收敛用户填的间隔。非法/空/越界一律回落到默认值，
 * 不抛错——设置项不该让服务起不来。
 */
export function clampInterval(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MIN;
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(n)));
}

/**
 * 计算下次运行时刻。
 * @param {number} lastAt  上次成功同步的时间戳（ms），0/空表示从未同步
 * @param {number} intervalMin 间隔分钟
 * @param {number} nowMs 当前时间
 * @returns {number} 下次应运行的时刻（ms）
 *
 * 关键语义：错过就现在补，而不是把时间表往后顺延。
 * 如果刚才因为关机错过了三个周期，恢复后应当立刻同步一次，
 * 而不是再等两小时——否则「两小时同步一次」在重启后变成「一直不同步」。
 */
export function nextRunAt(lastAt, intervalMin, nowMs = Date.now()) {
  const itv = clampInterval(intervalMin) * 60 * 1000;
  const last = Number(lastAt) || 0;
  if (!last) return nowMs;              // 从未同步过：立刻来一次
  const due = last + itv;
  return due <= nowMs ? nowMs : due;    // 已过期 → 立刻；未到 → 到点
}

/** 距离下次运行还有多少毫秒（0 表示该跑了） */
export function msUntilNext(lastAt, intervalMin, nowMs = Date.now()) {
  return Math.max(0, nextRunAt(lastAt, intervalMin, nowMs) - nowMs);
}

/** 间隔的人类可读说法，给设置页和侧栏提示用 */
export function humanInterval(min) {
  const n = clampInterval(min);
  if (n < 60) return `${n} 分钟`;
  const h = n / 60;
  if (Number.isInteger(h)) return `${h} 小时`;
  return `${Math.floor(h)} 小时 ${n % 60} 分钟`;
}

/**
 * 把 meta 表里存的时间值解析成 ms 时间戳。
 *
 * 库里这列存的是 ISO 字符串（`new Date().toISOString()`），不是数字，
 * 所以**不能直接 Number()**——`Number("2026-10-27T…")` 是 NaN，
 * 会静默变成 0，让调度器误以为「从未同步过」而每 5 秒重试一次。
 * 这个坑已实测复现过，注释留在这里防止有人「优化」回去。
 *
 * 同时兼容本来就被写成数字的情况（早期版本 / 手工改库）。
 */
export function parseStamp(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {                 // 纯数字串按 ms 时间戳读
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 自动同步的运行时快照，给设置页和 GET 接口共用。
 * 让前端不必自己算 next_run_at，避免和真实定时器对不上。
 * @param {{ok?:string, attempt?:string, error?:string, interval:number, nowMs?:number}} p
 */
export function autoSyncRuntime({ ok, attempt, error, interval, nowMs = Date.now() }) {
  const lastOk = parseStamp(ok);
  const lastTry = parseStamp(attempt);   // 失败也算一次尝试
  const base = Math.max(lastOk, lastTry);
  return {
    last_ok: lastOk,
    last_error: error || "",
    next_run_at: base ? nowMs + msUntilNext(base, interval, nowMs) : nowMs,
  };
}
