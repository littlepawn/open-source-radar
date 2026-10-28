import { describe, test, expect } from "bun:test";
import { markdown } from "../public/md.js";

// 这些用例都是审查里实测出问题、修完后作为回归护栏留下的。
// 任何一条变红都说明踩回同一个坑。
describe("markdown 链接解析", () => {
  test("普通链接 / 锚点 / 一层括号的 URL 都能解析", () => {
    expect(markdown("[x](https://a.com/b)", null)).toContain('href="https://a.com/b"');
    expect(markdown("[锚](#sec)", null)).toContain('class="mdlink"');
    // 维基那类 URL 里合法地带一层括号
    expect(markdown("[w](https://en.wikipedia.org/wiki/Foo_(bar))", null))
      .toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
  });

  test("链接文字不会跨行吞掉后续内容", () => {
    const out = markdown("[a](b) [c](d)", null);
    expect(out).toContain("a c");   // 相对链接不带 base 时只留文字
  });

  test("相对图片拼成 CDN，绝对图片原样，空的 alt 不报错", () => {
    expect(markdown("![图](a.png)", "o/r")).toContain("cdn.jsdelivr.net/gh/o/r@HEAD/a.png");
    expect(markdown("![](https://x/y.png)", "o/r")).toContain('alt=""');
  });

  test("200KB 的畸形输入必须秒回（曾因灾难性回溯卡 15 秒）", () => {
    // 老实现：X*(?:Y*Z*)* 里两个量词都能匹配空串，一行未配对的 [ 会枚举所有拆分。
    // 下面三组在修复前分别要 15.4s / 15.5s / 5.3s。
    const inputs = ["[".repeat(200000), "[[".repeat(100000), "[a](b".repeat(40000)];
    for (const s of inputs) {
      const t0 = Date.now();
      markdown(s, null);
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });
});

describe("markdown 危险面", () => {
  test("事件处理器 / style / class 一律丢弃", () => {
    expect(markdown("<img src=x onerror=alert(1)>", null)).toBe("<p></p>");
    expect(markdown("<div style=\"x\" onclick=\"y\">hi</div>", null)).not.toContain("onclick");
  });

  test("javascript: 协议在 href / src / poster 上都不留", () => {
    expect(markdown('<a href="javascript:alert(1)">x</a>', null)).not.toContain("javascript:");
    expect(markdown('<video src="https://a/b.mp4" poster="javascript:alert(1)"></video>', null))
      .not.toContain("javascript:");
  });

  test("poster 的相对路径和 src 一样被改写成 CDN", () => {
    const out = markdown('<video src="https://a/b.mp4" poster="./cover.png"></video>', "o/r");
    expect(out).toContain("cdn.jsdelivr.net/gh/o/r@HEAD/cover.png");
  });

  test("块级 HTML 不再留 \\u0002 控制符（曾被压入却从没清掉）", () => {
    const out = markdown('<div align="center">\nhello\n</div>\n\ntext', null);
    expect(out.includes("\u0002")).toBe(false);
    expect(out).toContain("hello");
    expect(out).toContain("<p>text</p>");
  });
});
