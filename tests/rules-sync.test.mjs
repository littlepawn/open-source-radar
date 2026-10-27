/* 三份规则表的同步断言。
   AGENTS.md 的硬约束：lib/rules.mjs 是唯一权威，public/rules.js 与
   scripts/rules.json 由 scripts/gen-rules.mjs 从它生成。
   以前是三处手抄，改一处忘另两处就会出现「抽屉里预览的和保存后的对不上」。
   这里不测规则本身对不对（那是 rules.test.mjs 的事），只测三处没有漂移。 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RULES, ruleDigest } from "../lib/rules.mjs";
import gen from "../public/rules.js";

const json = JSON.parse(readFileSync(new URL("../scripts/rules.json", import.meta.url), "utf8"));

// 一组能同时喂给三个实现的样本：[name, description, topics]
const SAMPLES = [
  ["obsidian-vault", "Obsidian second brain knowledge base", ["obsidian"]],
  ["scrcpy", "Display and control your Android device, uses adb", ["android"]],
  ["dragon", "dragon themed game engine", []],
  ["sandbox", "malware analysis sandbox", []],
  ["clips", "Clips and 剪映 video editor with animation", []],
  ["note", "A note-taking app with storage backend", []],
  ["fmt", "format a string utility", []],
  ["rag", "rag pipeline with embeddings", []],
  ["pptx", "export markdown to ppt", []],
  ["pdf", "pdf toolkit", []],
  ["orm", "a lightweight orm for go", []],
  ["ui", "a component ui kit", []],
];

const rowOf = ([name, description, topics]) => ({
  name, description, topics, language: "Go", stars: 10, pushed_at: "2026-01-01",
});

describe("规则表三处同步", () => {
  test("scripts/rules.json 与 lib/rules.mjs 条数一致", () => {
    expect(json.count).toBe(RULES.length);
    expect(json.rules.length).toBe(RULES.length);
  });

  test("scripts/rules.json 的每条正则与标签与 lib 逐条相同", () => {
    json.rules.forEach((r, i) => {
      expect(r[0]).toBe(RULES[i][0].source);
      expect(r[1]).toBe(RULES[i][1]);
      expect(r[2]).toBe(RULES[i][2]);
    });
  });

  test("public/rules.js 生成的正则与 lib 逐条相同", () => {
    expect(gen.RULES.length).toBe(RULES.length);
    gen.RULES.forEach((r, i) => {
      expect(r[0].source).toBe(RULES[i][0].source);
      expect(r[2]).toBe(RULES[i][2]);
      // 前端统一带 i —— lib 里如果有规则故意区分大小写，这里会红，属于提醒而非放行
      expect(r[0].flags).toBe("i");
    });
  });

  test("前端预览产出的标签与服务端落库的一致", () => {
    // 前端 rulePreview 只回字符串，这里直接比它内部用的规则：
    // 对每个样本，前端按同一顺序第一条命中必须给出和服务端首个标签相同的归类。
    const serverFirstTag = (s) => ruleDigest(rowOf(s)).tags[0] || "";
    const frontFirstTag = (s) => {
      const [name, description, topics] = s;
      const hay = `${description} ${topics.join(" ")} ${name} Go`.toLowerCase();
      const hit = gen.RULES.find(([re]) => re.test(hay));
      return hit ? hit[2] : "";
    };
    for (const s of SAMPLES) expect(frontFirstTag(s)).toBe(serverFirstTag(s));
  });

  test("前端预览在样本上都能给出非空文案", () => {
    for (const s of SAMPLES) {
      const out = gen.rulePreview(rowOf(s[0], s[1], s[2]) ? { ...rowOf(s), topics: s[2] } : rowOf(s), s[2]);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test("generated_from 指向唯一权威", () => {
    expect(json.generated_from).toBe("lib/rules.mjs");
  });

  // 上面几条比的是「已落盘的产物」，改了 lib 但忘了跑 gen-rules.mjs 时它们照样绿。
  // 这条直接按 lib 重新算一遍期望值，产物与 lib 有半点不同就红。
  test("落盘产物与 lib/rules.mjs 实时一致（防忘记重跑 gen-rules）", () => {
    const expectRaw = RULES.map(([re, phrase, tag]) => [re.source, phrase, tag]);
    expect(json.rules).toEqual(expectRaw);
    expect(gen.RAW).toEqual(expectRaw);
  });
});
