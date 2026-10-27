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
  test("形状与数量", () => {
    expect(RULES.length).toBeGreaterThan(20);
    // 每条都必须是 [RegExp, 文案] 形状，否则 ruleDigest 会静默产出 undefined
    for (const r of RULES) {
      expect(r[0]).toBeInstanceOf(RegExp);
      expect(typeof r[1]).toBe("string");
      expect(r[1].length).toBeGreaterThan(0);
    }
  });

  // 下面两条才是「顺序即具体度」的真断言。早先只校验了条数和形状，
  // 把两条规则对调位置测试照样 pass —— 而顺序决定了 ppt 库归「文档办公」
  // 还是被后面的宽泛规则抢走。用行为断言而不是比对正则源码：
  // 源码怎么写都能过，只要最终结果对。
  test("顺序即具体度：具体规则先命中，不被后面的宽泛规则抢走", () => {
    const dig = (description) =>
      ruleDigest({ name: "r", description, topics: [], language: "Go", stars: 1, pushed_at: "2026-01-01" });
    // PPT 规则在最前，所以「ppt 导出」必须落「文档办公」，
    // 不能被后面含 office/docx 的那条或「前端 UI」抢走。
    expect(dig("export markdown to ppt").tags[0]).toBe("文档办公");
    expect(dig("export markdown to ppt").digest).toContain("PPT");
    // PDF 在前、OCR 在后：单纯「pdf」应归文档办公，只有带 ocr/扫描才归 OCR
    expect(dig("pdf toolkit").tags[0]).toBe("文档办公");
    expect(dig("ocr scan to text").tags).toContain("OCR");
    // 安卓 adb 规则在「数据库」/「命令行工具」之前，adb shell 应归安卓
    expect(dig("adb shell tool for android").tags).toContain("安卓逆向");
  });

  // 短词不加边界会吃掉别的单词：rag→d**rag**on、orm→f**orm**at、ui→b**ui**ld、ide→gu**ide**。
  // 这份误判清单是踩出来的，直接拿真单词喂引擎，比静态查正则源码可靠。
  test("短词不误伤：含短词的无关单词不得被归类", () => {
    const dig = (description) =>
      ruleDigest({ name: "r", description, topics: [], language: "Go", stars: 1, pushed_at: "2026-01-01" });
    const noHit = [
      ["dragon themed game engine", "RAG / 向量库"],   // rag → d**rag**on
      ["format a string utility", "数据库"],            // orm → f**orm**at
      ["build tool for go", "前端 UI"],                 // ui → b**ui**ld
      ["a guide to rust", "编辑器 IDE"],                // ide → gu**ide**
      ["storage driver for docker", "RAG / 向量库"],    // rag → sto**rag**e
    ];
    for (const [desc, bad] of noHit) expect(dig(desc).tags).not.toContain(bad);
  });

  test("短词该命中时仍然命中", () => {
    const dig = (description) =>
      ruleDigest({ name: "r", description, topics: [], language: "Go", stars: 1, pushed_at: "2026-01-01" });
    const hits = [
      ["rag pipeline with embeddings", "RAG / 向量库"],
      ["a lightweight orm for go", "数据库"],
      ["a component ui kit", "前端 UI"],
      ["neovim based ide", "编辑器 IDE"],
      ["pdf toolkit", "文档办公"],
      ["adb shell tool for android", "安卓逆向"],
    ];
    for (const [desc, want] of hits) expect(dig(desc).tags).toContain(want);
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
