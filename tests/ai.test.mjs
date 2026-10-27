/* lib/ai.mjs 的单元测试：token 估算、裁剪、关键文件挑选、prompt 组装、配置校验。
   AI 这块最容易出的不是「崩」，而是「悄悄把上下文撑爆」或「配置半对半错却不报」，
   所以断言集中在边界与预算守恒上。 */
import { describe, expect, test } from "bun:test";
import { estimateTokens, clip, pickKeyFiles, topDirs, buildMessages, AI_PRESETS, validateAiConfig } from "../lib/ai.mjs";

describe("estimateTokens", () => {
  test("中文比英文更贵（同样字符数 token 更多）", () => {
    const zh = estimateTokens("这是一段中文描述");
    const en = estimateTokens("this is english");
    expect(zh).toBeGreaterThan(0);
    expect(estimateTokens("中文中文中文中文")).toBeGreaterThan(estimateTokens("a b c d e"));
    expect(en).toBeGreaterThan(0);
  });
  test("空值返回 0 而不是 NaN", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe("clip", () => {
  // 约定：clip 返回 { text, truncated }，调用方靠 truncated 决定要不要加「已截断」提示
  test("短文本原样返回且标记未截断", () => {
    expect(clip("hello", 100)).toEqual({ text: "hello", truncated: false });
  });
  test("超长文本被截断且保留头部", () => {
    const long = "A".repeat(5000);
    const out = clip(long, 100);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThan(long.length);
    expect(out.text.startsWith("AAA")).toBe(true);
  });
  test("截断后 token 不超预算", () => {
    const long = "中文测试内容".repeat(3000);
    const out = clip(long, 200);
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(200);
  });
  test("budget 为 0 或不合法时不抛错", () => {
    expect(typeof clip("abc", 0).text).toBe("string");
    expect(typeof clip("abc", -5).text).toBe("string");
  });
});

describe("pickKeyFiles", () => {
  const tree = [
    "README.md", "package.json", "LICENSE", "src/index.ts", "src/a/b/deep.ts",
    "Dockerfile", "docs/x.md", "test/y.test.ts", "go.mod", "main.go",
    "node_modules/pkg/index.js", "dist/bundle.js",
  ];
  test("优先挑根目录的清单文件", () => {
    const out = pickKeyFiles(tree, 5);
    expect(out).toContain("package.json");
  });
  test("不挑 node_modules / dist 里的产物", () => {
    const out = pickKeyFiles(tree, 20);
    for (const p of out) {
      expect(p.startsWith("node_modules/")).toBe(false);
      expect(p.startsWith("dist/")).toBe(false);
    }
  });
  test("尊重 limit，且不重复", () => {
    const out = pickKeyFiles(tree, 4);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(new Set(out).size).toBe(out.length);
  });
  test("空树返回空数组", () => {
    expect(pickKeyFiles([], 5)).toEqual([]);
  });
});

describe("topDirs", () => {
  test("统计顶层目录出现次数并按次数排序", () => {
    const out = topDirs(["src/a.ts", "src/b.ts", "docs/c.md", "README.md"], 2);
    expect(out[0]).toMatch(/src/);
    expect(out.length).toBeLessThanOrEqual(2);
  });
  test("根目录文件不算目录（靠「有没有 .」区分，带点的目录名会被漏掉）", () => {
    // 已知取舍：.github 这类以点开头的目录会被当成文件过滤掉。
    // 对「技术栈概览」这个用途来说可以接受，真需要看 .github 走 tree 全量。
    const out = topDirs(["README.md", "LICENSE", ".github/workflows"], 5);
    expect(out).not.toContain("README.md");
    expect(out).not.toContain("LICENSE");
  });
  test("去重并按首次出现顺序（不是值顺序）", () => {
    expect(topDirs(["src/a", "src/b", "docs/x"], 5)).toEqual(["src", "docs"]);
  });
});

describe("buildMessages", () => {
  const repo = {
    full_name: "o/r", description: "test repo", language: "TypeScript", stars: 1234,
    license: "MIT", pushed_at: "2026-01-01T00:00:00Z", archived: 0, digest: "中文简介",
  };
  test("第一条总是 system，最后一条是用户问题", () => {
    const msgs = buildMessages(repo, [], "这库怎么用？", { readme: "# Hi", tree: [], files: {} });
    expect(msgs[0].role).toBe("system");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "这库怎么用？" });
  });
  test("README 内容被带进上下文", () => {
    const msgs = buildMessages(repo, [], "q", { readme: "UNIQUE_MARKER_123", tree: [], files: {} });
    expect(JSON.stringify(msgs)).toContain("UNIQUE_MARKER_123");
  });
  test("超长 README 被裁到预算内，整体不爆", () => {
    const huge = "中文内容".repeat(20000);
    const msgs = buildMessages(repo, [], "q", { readme: huge, tree: [], files: {} }, 2000);
    const total = msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
    expect(total).toBeLessThan(6000);
  });
  test("history 被保留在同一位置（在 system 之后、当前问题之前）", () => {
    const history = [{ role: "user", content: "上一问" }, { role: "assistant", content: "上一答" }];
    const msgs = buildMessages(repo, history, "新问题", { readme: "", tree: [], files: {} });
    expect(msgs[1]).toEqual({ role: "user", content: "上一问" });
    expect(msgs[2].role).toBe("assistant");
    expect(msgs.at(-1).content).toBe("新问题");
  });
  test("没有 README / 没有文件也能组装（不抛错）", () => {
    expect(() => buildMessages(repo, [], "q", {})).not.toThrow();
    expect(() => buildMessages(repo, [], "q")).not.toThrow();
  });
  test("extraPrompt 被拼进 system", () => {
    const msgs = buildMessages(repo, [], "q", { readme: "", extraPrompt: "只用一句话回答" });
    expect(JSON.stringify(msgs[0])).toContain("只用一句话回答");
  });
});

describe("AI_PRESETS", () => {
  test("每个预设都有 id / label / base，拼地址不靠猜", () => {
    expect(AI_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const p of AI_PRESETS) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.label).toBe("string");
      // custom 是给中转站留的空位，base 允许为空；其余必须是 http(s)
      if (p.id !== "custom") expect(/^https?:\/\//.test(p.base_url)).toBe(true);
    }
  });
  test("custom 预设留空，让用户填自己的中转地址", () => {
    const custom = AI_PRESETS.find((p) => p.id === "custom");
    expect(custom.base_url).toBe("");
  });
  test("预设 id 唯一", () => {
    const ids = AI_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("validateAiConfig", () => {
  const ok = { base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", max_tokens: 2000, temperature: 0.2 };
  test("合法配置返回空数组", () => {
    expect(validateAiConfig(ok)).toEqual([]);
  });
  test("base_url 非 http(s) 被拒", () => {
    expect(validateAiConfig({ ...ok, base_url: "ftp://x" }).length).toBeGreaterThan(0);
    expect(validateAiConfig({ ...ok, base_url: "api.deepseek.com" }).length).toBeGreaterThan(0);
  });
  test("model 为空被拒", () => {
    expect(validateAiConfig({ ...ok, model: "  " }).length).toBeGreaterThan(0);
  });
  test("max_tokens 非正或超过 32000 被拒", () => {
    expect(validateAiConfig({ ...ok, max_tokens: 0 }).length).toBeGreaterThan(0);
    expect(validateAiConfig({ ...ok, max_tokens: -1 }).length).toBeGreaterThan(0);
    expect(validateAiConfig({ ...ok, max_tokens: 999999 }).length).toBeGreaterThan(0);
    expect(validateAiConfig({ ...ok, max_tokens: 10 })).toEqual([]);   // 小但合法，放行
  });
  test("temperature 越界被拒", () => {
    expect(validateAiConfig({ ...ok, temperature: -1 }).length).toBeGreaterThan(0);
    expect(validateAiConfig({ ...ok, temperature: 3 }).length).toBeGreaterThan(0);
  });
  test("多个错误一次全报（不让用户改一个试一个）", () => {
    const errs = validateAiConfig({ base_url: "x", model: "", max_tokens: 0 });
    expect(errs.length).toBe(3);
    expect(errs.join(" ")).toContain("base_url");
    expect(errs.join(" ")).toContain("model");
    expect(errs.join(" ")).toContain("max_tokens");
  });
});
