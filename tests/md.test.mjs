/* public/md.js 的单元测试：README 渲染器是唯一的 HTML 注入面，
   所有放行标签都必须经过白名单，任何一处漏判都是可存储 XSS。
   这里按「攻击面」组织，而不是按函数组织。 */
import { describe, expect, test } from "bun:test";
import md from "../public/md.js";

const render = (s, base) => md.markdown(s, base);

describe("基础 markdown", () => {
  test("标题、列表、段落", () => {
    expect(render("# Hi")).toContain("<h1>Hi</h1>");
    expect(render("- a\n- b")).toContain("<li>a</li>");
    expect(render("普通段落")).toContain("<p>普通段落</p>");
  });
  test("行内 code 与围栏 code 都被转义", () => {
    expect(render("`<b>x</b>`")).toContain("&lt;b&gt;");
    const fenced = render("```\n<script>alert(1)</script>\n```");
    expect(fenced).toContain("&lt;script&gt;");
    expect(fenced).not.toContain("<script>");
  });
  test("空输入返回空串（不抛错）", () => {
    expect(render("")).toBe("");
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });
});

describe("XSS 攻击面", () => {
  test("script 标签一律被转义", () => {
    const out = render('<script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script");
  });
  test("事件处理器属性被丢弃", () => {
    const out = render('<img src="https://a/b.png" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });
  test("javascript: 链接不生成可点击锚点", () => {
    const out = render("[x](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain('href="javascript');
  });
  test("data:text/html 链接被丢弃", () => {
    const out = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(out).not.toContain('href="data:text/html');
  });
  test("iframe / object / embed 一律不出现在输出里", () => {
    for (const tag of ["iframe", "object", "embed", "form", "style"]) {
      const out = render(`<${tag} src="x"></${tag}>`);
      expect(out).not.toContain(`<${tag}`);
    }
  });
  test("style 属性被丢弃（CSP 之外的额外一层）", () => {
    const out = render('<div style="background:url(javascript:alert(1))">x</div>');
    expect(out).not.toContain("style=");
  });
  test("HTML 注释不会漏成文本", () => {
    expect(render("a<!-- 隐藏 -->b")).not.toContain("<!--");
  });
});

describe("图片与链接改写", () => {
  test("外链图片原样保留并加 lazy", () => {
    const out = render('<img src="https://example.com/x.png">');
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain("loading=");
  });
  test("相对图片在给了 base 时改写成 CDN", () => {
    const out = render("![logo](./docs/logo.svg)", "owner/repo");
    expect(out).toContain("cdn.jsdelivr.net/gh/owner/repo@HEAD/docs/logo.svg");
  });
  test("相对图片没有 base 时整条丢弃（不留破图标）", () => {
    const out = render("![logo](./docs/logo.svg)");
    expect(out).not.toContain("<img");
  });
  test("srcset 里多个 URL 都单独改写", () => {
    const out = render('<source srcset="./a.svg, ./b.svg">', "o/r");
    const count = (out.match(/cdn\.jsdelivr\.net/g) || []).length;
    expect(count).toBe(2);
  });
  test("外链锚点带 target=_blank 与 rel", () => {
    const out = render("[x](https://example.com)");
    expect(out).toContain('rel="noreferrer"');
    expect(out).toContain('target="_blank"');
  });
  test("仓库内相对链接不生成可点锚点（本地没有那个文件）", () => {
    const out = render("[doc](./CONTRIBUTING.md)", "o/r");
    expect(out).not.toContain('href="./CONTRIBUTING.md"');
  });
});

describe("真实 README 片段", () => {
  test("徽章行（多个 img + a 嵌套）不产生裸露标签文本", () => {
    const src = '[![a](https://x/a.svg)](https://x) [![b](https://x/b.svg)](https://y)';
    const out = render(src);
    expect(out).not.toContain("&lt;img");
    expect(out).toContain("<img");
  });
  test("<picture><source> 响应式图片不把 source 当文本吐出来", () => {
    const src = '<picture><source media="(prefers-color-scheme: dark)" srcset="https://x/d.svg"><img src="https://x/l.svg"></picture>';
    const out = render(src);
    expect(out).not.toContain("&lt;source");
  });
  test("中文正文不被破坏", () => {
    expect(render("这是一个开源项目，用来做本地收藏管理。")).toContain("这是一个开源项目");
  });
  test("超长 README 被截断到 200KB 以内", () => {
    const out = render("x".repeat(300000));
    expect(out.length).toBeLessThanOrEqual(200000 * 6);
  });
});
