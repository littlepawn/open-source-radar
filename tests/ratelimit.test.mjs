import { test, expect, describe } from "bun:test";
import { readRate, mergeRate, rateFor, rateText, KNOWN_RESOURCES } from "../lib/ratelimit.mjs";

// 造一个最小 Headers 替身（不依赖 fetch，测试可在任何环境跑）
const H = (obj) => {
  const m = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (k) => (m.has(String(k).toLowerCase()) ? m.get(String(k).toLowerCase()) : null) };
};

describe("readRate", () => {
  test("解析 search 桶，reset 由秒转毫秒", () => {
    const r = readRate(H({
      "x-ratelimit-limit": "30",
      "x-ratelimit-remaining": "23",
      "x-ratelimit-reset": "1793157648",
      "x-ratelimit-resource": "search",
    }), 1000);
    expect(r).toEqual({ resource: "search", limit: 30, remaining: 23, reset: 1793157648000, at: 1000 });
  });

  test("解析 core 桶", () => {
    const r = readRate(H({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4963",
      "x-ratelimit-reset": "1793159843",
      "x-ratelimit-resource": "core",
    }));
    expect(r.resource).toBe("core");
    expect(r.limit).toBe(5000);
    expect(r.remaining).toBe(4963);
  });

  test("缺 resource 头时回落 core（GitHub 旧版本行为）", () => {
    const r = readRate(H({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": "12" }));
    expect(r.resource).toBe("core");
  });

  test("缺 limit 或 remaining 返回 null（304 与部分错误响应不带配额头）", () => {
    expect(readRate(H({ "x-ratelimit-remaining": "5" }))).toBeNull();
    expect(readRate(H({ "x-ratelimit-limit": "30" }))).toBeNull();
    expect(readRate(H({}))).toBeNull();
  });

  test("非数字头当缺失处理，不产生 NaN", () => {
    expect(readRate(H({ "x-ratelimit-limit": "abc", "x-ratelimit-remaining": "1" }))).toBeNull();
    expect(readRate(H({ "x-ratelimit-limit": "30", "x-ratelimit-remaining": "" }))).toBeNull();
  });

  test("无 reset 头时 reset 为 null，其余字段照常", () => {
    const r = readRate(H({ "x-ratelimit-limit": "30", "x-ratelimit-remaining": "7", "x-ratelimit-resource": "search" }));
    expect(r.reset).toBeNull();
    expect(r.remaining).toBe(7);
  });

  test("传 null / 非 Headers 不抛异常", () => {
    expect(readRate(null)).toBeNull();
    expect(readRate({})).toBeNull();
  });
});

describe("mergeRate", () => {
  test("按 resource 分桶，互不覆盖", () => {
    let rates = {};
    rates = mergeRate(rates, { resource: "search", limit: 30, remaining: 29, reset: 1, at: 1 });
    rates = mergeRate(rates, { resource: "core", limit: 5000, remaining: 4999, reset: 2, at: 2 });
    expect(Object.keys(rates).sort()).toEqual(["core", "search"]);
    expect(rates.search.remaining).toBe(29);
    expect(rates.core.remaining).toBe(4999);
  });

  test("同资源后写覆盖先写", () => {
    let rates = mergeRate({}, { resource: "search", limit: 30, remaining: 29, reset: 1 });
    rates = mergeRate(rates, { resource: "search", limit: 30, remaining: 28, reset: 1 });
    expect(rates.search.remaining).toBe(28);
  });

  test("entry 为 null 时原样返回，且不产生新对象引用变化以外的副作用", () => {
    const base = { search: { resource: "search", limit: 30, remaining: 1 } };
    expect(mergeRate(base, null)).toBe(base);
  });

  test("rates 为 undefined 时能初始化", () => {
    const r = mergeRate(undefined, { resource: "core", limit: 5000, remaining: 1 });
    expect(r.core.limit).toBe(5000);
  });

  test("不原地修改传入对象（便于快照与并发读）", () => {
    const base = {};
    const next = mergeRate(base, { resource: "core", limit: 1, remaining: 1 });
    expect(Object.keys(base)).toEqual([]);
    expect(Object.keys(next)).toEqual(["core"]);
  });
});

describe("rateFor", () => {
  const rates = {
    search: { resource: "search", limit: 30, remaining: 23, reset: 2000, at: 1000 },
    core: { resource: "core", limit: 5000, remaining: 4963, reset: 9000, at: 1000 },
  };

  test("窗口未过期时原样返回，expired=false", () => {
    const r = rateFor(rates, "search", 1500);
    expect(r.remaining).toBe(23);
    expect(r.expired).toBe(false);
  });

  test("窗口已过期时余量回满、reset 清空（search 每分钟一窗）", () => {
    const r = rateFor(rates, "search", 2000);
    expect(r.remaining).toBe(30);
    expect(r.reset).toBeNull();
    expect(r.expired).toBe(true);
  });

  test("过期边界用 >=：reset 当刻即视为已重置", () => {
    expect(rateFor(rates, "search", 1999).expired).toBe(false);
    expect(rateFor(rates, "search", 2000).expired).toBe(true);
  });

  test("core 与 search 各自独立判断过期", () => {
    // t=3000：search 已过期，core 还没
    expect(rateFor(rates, "search", 3000).expired).toBe(true);
    expect(rateFor(rates, "core", 3000).expired).toBe(false);
    expect(rateFor(rates, "core", 3000).remaining).toBe(4963);
  });

  test("未知资源返回 null", () => {
    expect(rateFor(rates, "graphql", 1000)).toBeNull();
    expect(rateFor({}, "search", 1000)).toBeNull();
    expect(rateFor(null, "search", 1000)).toBeNull();
  });

  test("reset 为 null 时永不过期（拿不到窗口就不猜）", () => {
    const r = rateFor({ search: { resource: "search", limit: 30, remaining: 5, reset: null } }, "search", 9e12);
    expect(r.remaining).toBe(5);
    expect(r.expired).toBe(false);
  });
});

describe("rateText", () => {
  test("正常余量写成 剩余/上限", () => {
    expect(rateText({ limit: 30, remaining: 23, expired: false })).toBe("配额 23/30");
  });
  test("过期满额写「已重置」", () => {
    expect(rateText({ limit: 30, remaining: 30, expired: true })).toBe("配额已重置");
  });
  test("无 limit 时退回「剩余 n」", () => {
    expect(rateText({ remaining: 7, expired: false })).toBe("配额剩余 7");
  });
  test("null / 无余量返回空串（界面据此不显示）", () => {
    expect(rateText(null)).toBe("");
    expect(rateText({ remaining: null })).toBe("");
  });
});

describe("回归：core 与 search 不得互相覆盖", () => {
  test("搜索后跑一次 core 请求，两个桶各自保留真实值", () => {
    let rates = {};
    // 1) 搜索
    rates = mergeRate(rates, readRate(H({
      "x-ratelimit-limit": "30", "x-ratelimit-remaining": "29",
      "x-ratelimit-reset": "1000", "x-ratelimit-resource": "search",
    }), 1));
    // 2) core（同步 / 查 release）
    rates = mergeRate(rates, readRate(H({
      "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4992",
      "x-ratelimit-reset": "99999", "x-ratelimit-resource": "core",
    }), 1));
    expect(rateFor(rates, "search", 2).remaining).toBe(29);
    expect(rateFor(rates, "search", 2).limit).toBe(30);
    expect(rateFor(rates, "core", 2).remaining).toBe(4992);
    expect(rateFor(rates, "core", 2).limit).toBe(5000);
  });
});

describe("KNOWN_RESOURCES", () => {
  test("包含 core 与 search（界面依赖这两个名字）", () => {
    expect(KNOWN_RESOURCES).toContain("core");
    expect(KNOWN_RESOURCES).toContain("search");
  });
});
