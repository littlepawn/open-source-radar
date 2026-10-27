import { test, expect, describe } from "bun:test";
import { buildDiscoverQuery, clampInt, DISCOVER_DEFAULTS, sortKey } from "../lib/discover.mjs";

// 固定「现在」，否则 created:> 的日期会随当前时间漂移，测试第二天就红。
const NOW = new Date("2026-10-27T00:00:00Z").getTime();

describe("clampInt", () => {
  test("空值 / null / 空串回落到 fallback", () => {
    expect(clampInt(undefined, 2000, 0, 5e6)).toBe(2000);
    expect(clampInt(null, 2000, 0, 5e6)).toBe(2000);
    expect(clampInt("", 2000, 0, 5e6)).toBe(2000);
  });

  test("非数字回落，不产生 NaN", () => {
    expect(clampInt("abc", 2000, 0, 5e6)).toBe(2000);
    expect(clampInt(NaN, 2000, 0, 5e6)).toBe(2000);
    expect(clampInt({}, 2000, 0, 5e6)).toBe(2000);
  });

  test("越界收进区间而不是丢弃", () => {
    expect(clampInt(99999999, 2000, 0, 5e6)).toBe(5_000_000);
    expect(clampInt(-5, 365, 1, 3650)).toBe(1);
    expect(clampInt(0, 365, 1, 3650)).toBe(1);
  });

  test("小数四舍五入，字符串数字可用", () => {
    expect(clampInt("1200.6", 0, 0, 5e6)).toBe(1201);
    expect(clampInt("5000", 0, 0, 5e6)).toBe(5000);
  });
});

describe("sortKey", () => {
  test("只认 updated，其余一律 stars", () => {
    expect(sortKey("updated")).toBe("updated");
    expect(sortKey("stars")).toBe("stars");
    expect(sortKey("")).toBe("stars");
    expect(sortKey(undefined)).toBe("stars");
    expect(sortKey("updatedX")).toBe("stars");
  });
});

describe("buildDiscoverQuery", () => {
  test("总 Star 榜不传阈值时用默认 2000 / 365 天", () => {
    const r = buildDiscoverQuery({ sort: "stars", now: NOW });
    expect(r.query).toContain("stars:>2000");
    expect(r.query).toContain("created:>2025-10-27");
    expect(r.sortField).toBe("stars");
  });

  test("最近活跃榜默认 200 星 / 90 天，排序字段是 updated", () => {
    const r = buildDiscoverQuery({ sort: "updated", now: NOW });
    expect(r.query).toContain("stars:>200");
    expect(r.query).toContain("created:>2026-07-29");
    expect(r.sortField).toBe("updated");
  });

  test("用户自定义阈值优先于默认", () => {
    const r = buildDiscoverQuery({ sort: "stars", stars: 5000, days: 30, now: NOW });
    expect(r.query).toContain("stars:>5000");
    expect(r.query).toContain("created:>2026-09-27");
    expect(r.minStars).toBe(5000);
    expect(r.maxAge).toBe(30);
  });

  test("自定义语法生效时 stars / days 不参与", () => {
    const r = buildDiscoverQuery({ sort: "stars", q: "topic:homelab stars:>100", stars: 9999, days: 1, now: NOW });
    expect(r.query).toContain("topic:homelab");
    expect(r.query).toContain("stars:>100");
    expect(r.query).not.toContain("stars:>9999");
    expect(r.query).not.toContain("created:>");
  });

  test("总是补 fork:false / archived:false，但不覆盖用户自己写的", () => {
    expect(buildDiscoverQuery({ now: NOW }).query).toContain("fork:false");
    expect(buildDiscoverQuery({ now: NOW }).query).toContain("archived:false");
    const r = buildDiscoverQuery({ q: "language:rust fork:true archived:true", now: NOW });
    expect(r.query).toContain("fork:true");
    expect(r.query).toContain("archived:true");
    // 不能同时出现两种取值，否则 GitHub 搜索语义冲突
    expect(r.query).not.toContain("fork:false");
    expect(r.query).not.toContain("archived:false");
  });

  test("自定义语法首尾空格被清掉", () => {
    expect(buildDiscoverQuery({ q: "  topic:ai  ", now: NOW }).query.startsWith("topic:ai")).toBe(true);
  });

  test("注入性输入不会破坏 query 结构：负号/引号被 clamp 挡在数字外", () => {
    // 数字位传字符串，clamp 后只能落在合法区间内，不会被当成语法拼出去
    const r = buildDiscoverQuery({ sort: "stars", stars: "1) OR stars:<999999", now: NOW });
    expect(r.query).toMatch(/stars:>\d+/);
    expect(r.query).not.toContain("OR");
  });

  test("days 极大时收进 3650 天，不会算出 1970 年", () => {
    const r = buildDiscoverQuery({ sort: "stars", days: 99999, now: NOW });
    expect(r.maxAge).toBe(3650);
    expect(r.query).toContain("created:>2016-10-29");
  });

  test("默认值表按榜单分开，且都是正整数", () => {
    for (const k of ["stars", "updated"]) {
      expect(DISCOVER_DEFAULTS[k].stars).toBeGreaterThan(0);
      expect(DISCOVER_DEFAULTS[k].days).toBeGreaterThan(0);
    }
    // 总榜门槛必须高于活跃榜，否则「总 Star 榜」名不副实
    expect(DISCOVER_DEFAULTS.stars.stars).toBeGreaterThan(DISCOVER_DEFAULTS.updated.stars);
  });
});
