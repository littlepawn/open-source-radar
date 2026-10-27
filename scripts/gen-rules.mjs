/* 生成前端与 Python 侧共用的规则表，消灭「三份规则表各自漂移」。

   lib/rules.mjs 是唯一权威。产出两件东西：
   - public/rules.js  浏览器 UMD 包，public/app.js 的「用规则重算」预览用它
   - scripts/rules.json  scripts/import_mcp_cache.py 读它做离线导入归类

   用法：bun scripts/gen-rules.mjs
   改完 lib/rules.mjs 必须重跑本脚本，否则 tests/rules-sync.test.mjs 会红。 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "../lib/rules.mjs";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// fmt / ruleDigest 直接从 lib/rules.mjs 源码里切出来原样嵌入，而不是在生成器里
// 再抄一遍算法——抄一遍就等于又造了一份会漂移的实现。
const libSrc = readFileSync(join(ROOT, "lib", "rules.mjs"), "utf8");
const libBody = libSrc.slice(libSrc.indexOf("/** 数字缩写"));
if (!libBody.includes("export function ruleDigest")) throw new Error("lib/rules.mjs 结构变了，gen-rules.mjs 需要同步");
const fnBody = libBody.replace(/^export function /gm, "function ");

// 每条规则序列化成 [正则源码, 场景短语, 标签]，正则不带 flags（前端统一加 i）。
const rows = RULES.map(([re, phrase, tag]) => [re.source, phrase, tag]);

writeFileSync(
  join(ROOT, "scripts", "rules.json"),
  JSON.stringify({ generated_from: "lib/rules.mjs", count: rows.length, rules: rows }, null, 2) + "\n",
);

// 前端 UMD：浏览器挂 window.RadarRules，bun test 可 import
const js = `/* 由 scripts/gen-rules.mjs 从 lib/rules.mjs 生成，请勿手改。
   浏览器挂 window.RadarRules，测试可 import。 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.RadarRules = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const RAW = ${JSON.stringify(rows, null, 2)};
  const RULES = RAW.map(([src, phrase, tag]) => [new RegExp(src, "i"), phrase, tag]);

  // ↓↓↓ 以下 fmt / ruleDigest 由本脚本从 lib/rules.mjs 原样嵌入 ↓↓↓
${fnBody}
  // ↑↑↑ 与服务端落库用的是同一份实现，预览与保存后必然一致 ↑↑↑

  // 「用规则重算」只需要简介那一段（drawer 的 textarea），标签另有一套 UI
  function rulePreview(r, topics = []) {
    return ruleDigest({ ...r, topics }).digest;
  }

  return { RULES, RAW, fmt, ruleDigest, rulePreview };
});
`;
writeFileSync(join(ROOT, "public", "rules.js"), js);

console.log(`已生成 public/rules.js 与 scripts/rules.json（${rows.length} 条规则）`);
