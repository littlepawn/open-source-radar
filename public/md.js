/* 极简 markdown 渲染器 —— 可被浏览器和 bun test 同时加载（UMD）。
   浏览器：index.html 在 app.js 之前引入，挂到 window.RadarMD。
   测试：   import { miniMarkdown } from "../public/md.js"

   设计要点（踩过的坑都在这）：
   - 旧实现先把整篇 HTML 转义再替换 <img>，转义后 < 已成 &lt;，README 里的 HTML
     （<div align="center">、<p>、<a href>）全部退化成裸文本。现在是「钉住 code →
     逐行块级解析 → 行内解析 → 白名单放行标签」的顺序。
   - README 来自外部仓库，事件处理器 / style / iframe / script 一律丢弃。 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.RadarMD = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 只放行 http(s)：仓库的 homepage / README 里的链接都来自外部，
  // javascript: 与 data: 会变成可点击的 XSS。白名单之外一律返回空串。
  const safeUrl = (u) => {
    const s = String(u ?? "").trim();
    return /^https?:\/\//i.test(s) ? s : "";
  };

  // README 来自外部仓库，放行的 HTML 标签与属性都做白名单。
  const MD_VOID = new Set(["img", "br", "hr", "input", "wbr", "col"]);
  const MD_BLOCK = new Set([
    "div", "p", "center", "details", "summary", "table", "thead", "tbody", "tr", "td", "th",
    "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
    "a", "b", "i", "strong", "em", "del", "s", "u", "sub", "sup", "small", "br", "hr",
    "img", "picture", "source", "figure", "figcaption", "kbd", "mark", "span", "section", "article",
    "video", "audio", "track", "abbr", "time", "nav", "header", "footer", "main",
  ]);
  const MD_ATTR = {
    a: ["href", "title"],
    img: ["src", "srcset", "alt", "title", "width", "height"],
    // <picture> 的暗色模式徽章普遍写成 <source srcset=…>，不放行 srcset 会退化成
    // 一串裸露的 &lt;source …&gt; 文本。
    source: ["srcset", "media", "type", "sizes", "width", "height"],
    video: ["src", "poster", "width", "height", "controls", "loop", "muted", "playsinline"],
    audio: ["src", "controls", "loop"],
    td: ["colspan", "rowspan"], th: ["colspan", "rowspan"],
    div: ["align"], p: ["align"], h1: ["align"], h2: ["align"], h3: ["align"],
    center: ["align"], table: ["align"], span: ["title"],
  };

  const cdn = (base, p) => `https://cdn.jsdelivr.net/gh/${base}@HEAD/${String(p).replace(/^\.?\//, "")}`;

  // 标签内属性：只留白名单，href/src 再过 safeUrl
  function mdAttrs(tag, raw, base) {
    const allow = MD_ATTR[tag] || [];
    const out = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(raw))) {
      const name = m[1].toLowerCase();
      if (!allow.includes(name)) continue; // 事件处理器 / style / class 都在这里被丢
      let val = m[3] ?? m[4] ?? m[5] ?? "";
      if (name === "href") {
        // 相对链接指向仓库里的另一个文件，本地看板没有它，留着只会 404
        if (!/^https?:\/\//i.test(val) && !val.startsWith("#")) continue;
      }
      if (name === "src") {
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(val) && !/^https?:\/\//i.test(val) && !/^data:image\//i.test(val)) continue;
        if (/^https?:\/\//i.test(val) || /^data:image\//i.test(val)) { /* 原样放行 */ }
        else if (base) val = cdn(base, val);
        else continue; // 没有 base 就丢弃，避免破图标
      }
      if (name === "srcset") {
        // srcset 是「url 描述符, url 描述符」，逐个 URL 单独改写相对路径
        const fixed = String(val).split(",").map((part) => {
          const seg = part.trim();
          if (!seg) return "";
          const [u, ...desc] = seg.split(/\s+/);
          let nu = u;
          if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) && !/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) return "";
          if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) {
            if (!base) return "";
            nu = cdn(base, u);
          }
          return [nu, ...desc].join(" ");
        }).filter(Boolean);
        if (!fixed.length) continue; // 一个 URL 都不剩就整条丢掉
        out.push(`${name}="${esc(fixed.join(", "))}"`);
        continue;
      }
      out.push(`${name}="${esc(val)}"`);
    }
    return out.length ? " " + out.join(" ") : "";
  }

  function miniMarkdown(md, base) {
    // base = "owner/repo"，相对图片会拼成 CDN 地址；不传则丢相对图
    let src = String(md || "").slice(0, 200000);
    const stash = [];
    const save = (html) => `\u0000${stash.push(html) - 1}\u0000`;

    // 1) fenced code 先钉住，避免内部被当成 markdown
    src = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, _lang, code) =>
      save(`<pre><code>${esc(code.replace(/\s+$/, ""))}</code></pre>`)
    );
    // 2) 行内 code 也钉住
    src = src.replace(/`([^`\n]+)`/g, (_, c) => save(`<code>${esc(c)}</code>`));

    // 2.5) HTML 注释整段丢掉。徽章区常写成 `</a><!--\n  --><a ...>`，
    //      不剔除就会被转义成 &lt;!-- 显示。放在 code 占位之后，代码块里的示例不受影响。
    src = src.replace(/<!--[\s\S]*?-->/g, "");

    // 3) 行内解析：白名单 HTML 先标记，避免被下面当普通文本转义两次
    const inline = (text) => {
      const held = [];
      const hold = (html) => `\u0001${held.push(html) - 1}\u0001`;
      let t = text;
      t = t.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (full, nameRaw, attrs) => {
        const tag = nameRaw.toLowerCase();
        if (!MD_BLOCK.has(tag)) return esc(full);
        const close = full.startsWith("</");
        if (close) return MD_VOID.has(tag) ? "" : hold(`</${tag}>`);
        const selfClose = full.endsWith("/>") || MD_VOID.has(tag);
        const a = mdAttrs(tag, attrs || "", base);
        const linkExtras = tag === "a" && /\shref="/.test(a) ? ' target="_blank" rel="noreferrer"' : "";
        const loading = tag === "img" ? ' loading="lazy"' : "";
        // 相对路径图片在本地没有 base，src 被丢后只剩破图标；但响应式图片可以只有 srcset
        if (tag === "img" && !/\ssrc=/.test(a) && !/\ssrcset=/.test(a)) return "";
        return hold(`<${tag}${a}${loading}${linkExtras}${selfClose ? (MD_VOID.has(tag) ? ">" : " />") : ">"}`);
      });
      // 其余内容一律转义；已转义过的 & 不再二次转义
      t = t.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      // URL 里允许一层括号，否则 alert(1) 这类内容会把 ) 留在外面
      const URL_RE = "([^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*)";
      t = t.replace(new RegExp("!\\[([^\\]]*)\\]\\(\\s*" + URL_RE + "[^)]*\\)", "g"), (_, alt, src2) => {
        if (!/^https?:\/\//i.test(src2) && !/^data:image\//i.test(src2)) {
          if (!base) return "";
          src2 = cdn(base, src2);
        }
        return `<img src="${esc(src2)}" alt="${alt}" loading="lazy">`;
      });
      t = t.replace(new RegExp("\\[([^\\]]+)\\]\\(\\s*" + URL_RE + "[^)]*\\)", "g"), (_, label, href) => {
        if (/^https?:\/\//i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noreferrer">${label}</a>`;
        if (href.startsWith("#")) return `<a class="mdlink" href="${esc(href)}">${label}</a>`;
        return label;
      });
      t = t.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
      t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
      t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>");
      t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      t = t.replace(/ {2,}$/gm, "<br>");
      return t.replace(/\u0001(\d+)\u0001/g, (_, i) => held[Number(i)]);
    };

    // 4) 逐行块级解析
    const lines = src.split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let inHtmlBlock = 0;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();

      if (/^\u0000\d+\u0000$/.test(t)) { closeList(); out.push(t); continue; }

      // 自闭合写法 <div …/> 不增加块级深度，否则之后的整篇会滞留在 html 块里
      const htmlOpen = t.match(/^<([a-zA-Z][\w-]*)(\s[^>]*)?(\/?)>$/);
      if (htmlOpen && !MD_VOID.has(htmlOpen[1].toLowerCase()) && !htmlOpen[3]) { inHtmlBlock++; }
      if (inHtmlBlock > 0) {
        // GitHub 在 <div align="center"> 里照常渲染 markdown，所以块内仍要认标题和列表
        const hh = t.match(/^(#{1,6})\s+(.*)$/);
        if (hh) {
          out.push(`<h${hh[1].length}>${inline(hh[2])}</h${hh[1].length}>`);
        } else if (/^[-*+]\s+/.test(t)) {
          if (list !== "ul") { if (list) out.push(`</${list}>`); out.push("<ul>"); list = "ul"; }
          out.push(`<li>${inline(t.replace(/^[-*+]\s+/, ""))}</li>`);
        } else {
          if (list) { out.push(`</${list}>`); list = null; }
          out.push(inline(line));
        }
        if (/^<\/[a-zA-Z][\w-]*>$/.test(t)) inHtmlBlock--;
        if (inHtmlBlock === 0) { if (list) { out.push(`</${list}>`); list = null; } out.push("\u0002"); }
        continue;
      }

      if (!t) { closeList(); continue; }
      if (/^<!--/.test(t) || /^-->$/.test(t)) { closeList(); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeList(); out.push("<hr>"); continue; }

      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

      const bq = t.match(/^>\s?(.*)$/);
      if (bq) { closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

      const ul = t.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(ul[1])}</li>`);
        continue;
      }
      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ol) {
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }

      // 表格：连续的 | a | b | 行
      if (/^\|.*\|$/.test(t)) {
        closeList();
        const rows = [];
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(lines[i].trim()); i++; }
        i--;
        if (rows.length >= 2 && /^\|[\s:|-]+\|$/.test(rows[1])) {
          const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
          const head = cells(rows[0]);
          const body = rows.slice(2).map(cells);
          out.push(
            "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
            body.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
            "</tbody></table>"
          );
        } else {
          out.push(`<p>${rows.map((r) => inline(r)).join("<br>")}</p>`);
        }
        continue;
      }

      // 一行里既有块级容器标签又有正文时（`<table>…</table>` 后跟说明），包 <p> 会产生
      // <p><table> 这种非法嵌套，浏览器会提前闭合 <p>，视觉上多出空行。
      const startsWithBlock = /^<(?:div|p|center|details|summary|table|thead|tbody|tr|td|th|h[1-6]|ul|ol|li|blockquote|pre|picture|figure|section|article)\b/i.test(t);
      if (startsWithBlock) {
        const inner = inline(t);
        const opens = (inner.match(/<(?!\/)([a-zA-Z][\w-]*)/g) || []).length;
        const closes = (inner.match(/<\/([a-zA-Z][\w-]*)>/g) || []).length +
                       (inner.match(/<(?:img|br|hr|input|wbr|col)\b[^>]*>/g) || []).length;
        if (opens > 0 && opens === closes) { out.push(inner); continue; }
      }

      closeList();
      out.push(`<p>${inline(t)}</p>`);
    }
    closeList();

    let html = out.join("\n");
    // href 被丢掉的 <a> 没有跳转能力，剥成纯内容
    html = html.replace(/<a>([\s\S]*?)<\/a>/g, "$1");
    html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)] ?? "");
    html = html.replace(/\u0001(\d+)\u0001/g, "");
    return html;
  }

  // 对外只暴露一个 markdown()：调用方不该知道内部函数叫 miniMarkdown。
  // esc/safeUrl 也导出，给需在别处拼 HTML 的调用方复用，避免再抄第三份。
  return { markdown: miniMarkdown, miniMarkdown, esc, safeUrl, MD_VOID, MD_BLOCK, MD_ATTR, mdAttrs };
});
