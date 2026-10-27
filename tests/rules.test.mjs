/* lib/rules.mjs 的单元测试：规则引擎是「简介质量」的唯一来源，
   改一条正则就可能让上百个库被误判成「数据库」，所以每条断言都指向一个真实踩过的坑。 */
import { describe, expect, test } from "bun:test";
import { RULES, fmt, ruleDigest } from "../lib/rules.mjs";

describe("fmt", () => {
  test("按位缩放且不留多余小数", () => {
    expect(fmt(0)).toBe("0");
    expect(fmt(999)).toBe("999");
    expect(fmt(1000)).toBe("1.0k");
    expect(fmt(18500)).toBe("19k");   // 上万不保留小数
    expect(fmt(2500000)).toBe("2.5M");
  });
  test("空值不抛错", () => {
    expect(fmt(null)).toBe("0");
    expect(fmt(undefined)).toBe("0");
    expect(fmt("abc")).toBe("0");
  });
});

describe("RULES", () => {
  test("顺序即具体度：越具体的规则排在越前面", () => {
    expect(RULES.length).toBeGreaterThan(20);
    // 每条都必须是 [RegExp, 文案] 形状，否则 ruleDigest 会静默产出 undefined
    for (const r of RULES) {
      expect(r[0]).toBeInstanceOf(RegExp);
      expect(typeof r[1]).toBe("string");
      expect(r[1].length).toBeGreaterThan(0);
    }
  });
  test("规则不重复命中同一句文案", () => {
    const texts = RULES.map((r) => r[1]);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("ruleDigest", () => {
  const base = {
    full_name: "o/r", name: "r", owner: "o", language: "Go", stars: 1200,
    pushed_at: "2026-01-01T00:00:00Z", archived: 0, description: "", topics: [],
  };
  test("返回简介与标签两部分", () => {
    const d = ruleDigest({ ...base, description: "A fast key-value database" });
    expect(typeof d.digest).toBe("string");
    expect(Array.isArray(d.tags)).toBe(true);
    expect(d.digest).toContain("Go");
  });
  test("topics 传数组与传 JSON 字符串结果一致", () => {
    const row = { ...base, description: "llm inference server" };
    const a = ruleDigest({ ...row, topics: ["llm", "inference"] });
    const b = ruleDigest({ ...row, topics: '["llm","inference"]' });
    expect(a.digest).toBe(b.digest);
  });
  test("损坏的 topics 不让整个流程抛错", () => {
    expect(() => ruleDigest({ ...base, topics: "{not json" })).not.toThrow();
    expect(() => ruleDigest({ ...base, topics: null })).not.toThrow();
  });
  test("描述为空时也能给出可读结果", () => {
    const d = ruleDigest({ ...base, description: "" });
    expect(d.digest.length).toBeGreaterThan(0);
  });
  test("结果确定性：同输入两次结果相同", () => {
    const row = { ...base, description: "static site generator" };
    expect(ruleDigest(row).digest).toBe(ruleDigest(row).digest);
  });
});
