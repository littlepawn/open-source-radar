import { describe, expect, test, afterAll } from "bun:test";
import net from "node:net";
import {
  parseProxyUrl,
  configureProxy,
  outboundFetch,
  proxyStatus,
  testProxy,
} from "../lib/proxy.mjs";

afterAll(async () => { await configureProxy(null); });

describe("parseProxyUrl — 只认不臆造", () => {
  test("空值一律 null", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(parseProxyUrl(v)).toBeNull();
    }
  });

  test("省略协议按 http 处理（用户最常直接粘 127.0.0.1:7890）", () => {
    expect(parseProxyUrl("127.0.0.1:7890")).toMatchObject({ scheme: "http", host: "127.0.0.1", port: 7890 });
    expect(parseProxyUrl("proxy.lan:3128")).toMatchObject({ scheme: "http", host: "proxy.lan", port: 3128 });
  });

  test("http / https / socks5 / socks5h 都识别，大小写不敏感", () => {
    expect(parseProxyUrl("http://a:1").scheme).toBe("http");
    expect(parseProxyUrl("HTTPS://a:1").scheme).toBe("https");      // https 代理：桥里按 http 处理并改用 TLS 连代理
    expect(parseProxyUrl("SOCKS5://a:1").scheme).toBe("socks5");
    expect(parseProxyUrl("socks5h://a:1").scheme).toBe("socks5");   // 远端解析 DNS，桥本来就是远端解析
    expect(parseProxyUrl("socks://a:1").scheme).toBe("socks5");
  });

  test("端口缺省按协议给默认值", () => {
    expect(parseProxyUrl("http://a").port).toBe(8080);
    expect(parseProxyUrl("https://a").port).toBe(8080);   // https 代理=对代理本身 TLS，默认端口沿用 8080
    expect(parseProxyUrl("socks5://a").port).toBe(1080);
  });

  test("带账号密码", () => {
    const c = parseProxyUrl("socks5://u%40x:p%3Aw@127.0.0.1:1080");
    expect(c).toMatchObject({ scheme: "socks5", host: "127.0.0.1", port: 1080 });
    expect(decodeURIComponent(c.user)).toBe("u@x");       // 用户名里的 @ 必须能还原
    expect(decodeURIComponent(c.pass)).toBe("p:w");
  });

  test("不支持的协议明说，静默忽略会让人以为配上了", () => {
    expect(() => parseProxyUrl("ftp://a:1")).toThrow(/不支持/);
    expect(() => parseProxyUrl("http+unix://%2Ftmp%2Fs.sock")).toThrow(/不支持/);
  });

  test("端口与主机非法要抛", () => {
    expect(() => parseProxyUrl("http://a:0")).toThrow();
    expect(() => parseProxyUrl("http://a:70000")).toThrow();
    expect(() => parseProxyUrl("http://")).toThrow();
    expect(() => parseProxyUrl("http://a:abc")).toThrow();
  });

  test("非字符串输入不炸", () => {
    expect(parseProxyUrl(0)).toBeNull();
    expect(parseProxyUrl({})).toBeNull();
  });

  test("url 属性回显规范化后的地址（写进输入框）", () => {
    expect(parseProxyUrl("127.0.0.1:7890").url).toBe("http://127.0.0.1:7890");
    const withAuth = parseProxyUrl("socks5://user:pass@h:1080");
    expect(withAuth.url).toBe("socks5://user:****@h:1080");   // 密码在回显里打码
  });
});

// 一个极简的「代理」：http 目标回 200，用来验证桥确实把请求发到了代理而不是直连
function fakeProxy() {
  const seen = [];
  const srv = net.createServer((s) => {
    s.on("error", () => {});
    s.once("data", (d) => {
      seen.push(d.toString("latin1").split("\r\n")[0]);
      s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
    });
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, seen, port: srv.address().port })));
}

describe("configureProxy / outboundFetch", () => {
  test("不配代理时 outboundFetch 等同裸 fetch（HTTP_PROXY 环境变量不自动生效）", async () => {
    await configureProxy(null);
    expect(proxyStatus()).toMatchObject({ url: "", enabled: false });
  });

  test("直连失败时抛出带代理说明的错误信息", async () => {
    await configureProxy(null);
    let err = null;
    try {
      await outboundFetch("https://127.0.0.1:9/nope", { signal: AbortSignal.timeout(3000) });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err.message)).toContain("直连（未配置代理）失败");
  });

  test("配了 http 代理后，请求确实经过代理", async () => {
    const { srv, seen, port } = await fakeProxy();
    try {
      await configureProxy(parseProxyUrl(`http://127.0.0.1:${port}`));
      const st = proxyStatus();
      expect(st.enabled).toBe(true);
      expect(st.bridge_port).toBeGreaterThan(0);
      expect(st.url).toBe(`http://127.0.0.1:${port}`);
      const r = await outboundFetch("http://example.invalid/x", { signal: AbortSignal.timeout(5000) });
      expect(r.status).toBe(200);
      // 请求到了代理就证明没走直连（example.invalid 直连必失败）。
      // http 目标按 CONNECT 隧道过来，所以首行是 CONNECT 而不是绝对 URI。
      expect(seen[0]).toContain("example.invalid");
    } finally { srv.close(); await configureProxy(null); }
  });

  test("代理连不上时报错里带上代理地址，方便判断是网络还是配置问题", async () => {
    await configureProxy(parseProxyUrl("socks5://127.0.0.1:9"));
    let err = null;
    try {
      await outboundFetch("https://example.com/", { signal: AbortSignal.timeout(4000) });
    } catch (e) { err = e; }
    // 桥连不上时代理地址与原因都要在，否则用户分不清是代理挂了还是外网挂了
    expect(String(err?.message || "")).toContain("连不上代理 socks5://127.0.0.1:9");
    expect(String(err?.message || "")).toContain("ECONNREFUSED");
    await configureProxy(null);
  });
});

describe("testProxy", () => {
  test("坏端口要抛错而不是返回 ok", async () => {
    let err = null;
    try { await testProxy(parseProxyUrl("socks5://127.0.0.1:9")); } catch (e) { err = e; }
    expect(err).toBeTruthy();
  });

  test("代理自己回 5xx 也算失败（不能把 502 当绿色通过）", async () => {
    const srv = net.createServer((s) => {
      s.on("error", () => {});
      s.once("data", () => s.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 7\r\n\r\nrefused"));
    });
    const port = await new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
    try {
      let err = null;
      try { await testProxy(parseProxyUrl(`http://127.0.0.1:${port}`)); } catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(String(err.message)).toContain("502");
    } finally { srv.close(); }
  });
});
