/* 出站代理：socks5 / http(s)，以及把 socks5 桥成 http 代理的本地 CONNECT 服务。
 *
 * 为什么需要这座桥：Bun 的 fetch 只认 http/https 代理，传 socks5:// 会直接抛
 * `UnsupportedProxyProtocol`（本机 Bun 1.4.2 实测，socks4/socks 同样不支持）。
 * 所以这里起一个只听 127.0.0.1 的小型 HTTP 代理，把 fetch 的 proxy 指向它，
 * 它再用 SOCKS5 隧道连出去。fetch 对 https 目标会发 CONNECT、对 http 目标会发
 * 绝对 URI（都实测过），两条路径都要接。
 *
 * 本文件不碰数据库：配置由 server.mjs 读出来传进来，这里只做协议与网络。
 */
import net from "node:net";
import http from "node:http";

const DEFAULT_PORT = { socks5: 1080, socks5h: 1080, http: 8080, https: 8080 };

/* 解析用户填的代理地址。接受：
 *   socks5://127.0.0.1:7890   socks5h://host:1080   http://host:3128
 *   https://host:8443         host:7890（省略协议按 socks5 处理）
 *   socks5://user:pass@host:1080
 * 返回 null 表示留空（不启用）；抛错表示格式不对。 */
export function parseProxyUrl(raw) {
  // 非字符串直接当没配：传 0、{} 这类进来是调用方写错，静默把它变成 http://0:8080 更糟
  if (raw == null || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // 没写协议：按 http 补全。用户多数直接粘「127.0.0.1:7890」，而 http 代理是本文件
  // 最宽的那条路——Bun 原生支持，socks5 还得我们自己打洞；猜 socks5 会在纯 http 代理上失败。
  if (!/^[a-z0-9+.-]+:\/\//i.test(s)) s = "http://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("代理地址解析失败，应形如 socks5://127.0.0.1:7890 或 http://host:3128");
  }
  let scheme = u.protocol.replace(":", "").toLowerCase();
  // socks5h = 让代理解析 DNS。桥里的 SOCKS5 握手一律发域名（ATYP=0x03），
  // 本来就是远端解析，所以 socks5h 不是另一种模式，归一到 socks5 少一条分支。
  if (scheme === "socks5h") scheme = "socks5";
  if (scheme === "socks") scheme = "socks5";
  if (!["socks5", "socks5h", "http", "https"].includes(scheme)) {
    // socks4 一律不支持：Bun 不支持，这里也没实现，早报错好过连上后诡异失败
    throw new Error(`不支持的代理协议 ${scheme}（可用 socks5 / socks5h / http / https）`);
  }
  if (!u.hostname) throw new Error("代理地址缺少主机名");
  const port = u.port ? Number(u.port) : DEFAULT_PORT[scheme];
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("代理端口不合法");
  return {
    scheme,
    host: u.hostname.replace(/^\[|\]$/g, ""),   // IPv6 字面量去掉方括号
    port,
    user: u.username ? decodeURIComponent(u.username) : "",
    pass: u.password ? decodeURIComponent(u.password) : "",
    // 只在出错提示/输入框回显里出现，绝不带密码
    display: `${scheme}://${u.hostname}:${port}`,
    // 前端输入框的回显值：带账号但密码打码，用户能看出自己配了凭证
    url: u.username
      ? `${scheme}://${decodeURIComponent(u.username)}:****@${u.hostname}:${port}`
      : `${scheme}://${u.hostname}:${port}`,
  };
}

/* SOCKS5（RFC 1928）+ 用户名密码认证（RFC 1929）握手，成功后返回原始 socket。 */
export function socks5Tunnel(cfg, host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(cfg.port, cfg.host);
    let stage = 0;
    let settled = false;
    const timer = setTimeout(() => fin(new Error(`SOCKS5 握手超时（${timeoutMs}ms）`)), timeoutMs);

    function fin(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      sock.removeListener("error", onError);
      sock.removeListener("close", onClose);
      if (err) { sock.destroy(); reject(err); } else { sock.setTimeout(0); resolve(sock); }
    }
    const onError = (e) => fin(new Error(`连不上代理 ${cfg.display}：${e.message}`));
    const onClose = () => fin(new Error(`代理 ${cfg.display} 提前断开`));

    function onData(d) {
      if (stage === 0) {
        // 方法协商：服务端回 VER METHOD
        if (d[0] !== 0x05) return fin(new Error(`代理 ${cfg.display} 不是 SOCKS5（返回版本 ${d[0]}）`));
        const method = d[1];
        if (method === 0x00) {
          stage = 2;
          return sendConnect();
        }
        if (method === 0x02) {
          if (!cfg.user) return fin(new Error("代理要求用户名密码，但没填"));
          stage = 1;
          const u = Buffer.from(cfg.user), p = Buffer.from(cfg.pass || "");
          return sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        }
        return fin(new Error("代理不接受无认证方式（可能是 socks4 或需其它认证）"));
      }
      if (stage === 1) {
        // RFC 1929 认证结果
        if (d[1] !== 0x00) return fin(new Error("代理用户名或密码错误"));
        stage = 2;
        return sendConnect();
      }
      // stage 2：CONNECT 回复
      if (d[1] !== 0x00) {
        const WHY = {
          1: "代理内部错误", 2: "规则不允许该连接", 3: "网络不可达",
          4: "目标主机不可达", 5: "目标拒绝连接", 6: "TTL 过期",
          7: "不支持的命令", 8: "不支持的地址类型",
        };
        return fin(new Error(`SOCKS5 连不上 ${host}:${port}（${WHY[d[1]] || "代码 " + d[1]}）`));
      }
      fin(null);
    }

    function sendConnect() {
      // ATYP=3 域名交给代理解析：本机 DNS 可能被污染，远端解析才是对的
      const h = Buffer.from(String(host));
      const isIp4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      const head = isIp4
        ? Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split(".").map(Number))])
        : Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h]);
      sock.write(Buffer.concat([head, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
    }

    sock.on("error", onError);
    sock.on("close", onClose);
    sock.on("data", onData);
    sock.once("connect", () => {
      const methods = cfg.user ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.concat([Buffer.from([0x05, methods.length]), Buffer.from(methods)]));
    });
  });
}

/* HTTP 代理：发 CONNECT 建隧道（对 80/443 都适用）。 */
export function httpProxyTunnel(cfg, host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(cfg.port, cfg.host);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => fin(new Error(`HTTP 代理握手超时（${timeoutMs}ms）`)), timeoutMs);

    function fin(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      sock.removeListener("error", onError);
      if (err) { sock.destroy(); reject(err); } else { sock.removeListener("data", onData); resolve(sock); }
    }
    const onError = (e) => fin(new Error(`连不上代理 ${cfg.display}：${e.message}`));

    function onData(d) {
      buf += d.toString("latin1");
      if (!buf.includes("\r\n\r\n")) {
        if (buf.length > 8192) fin(new Error("代理回了超长的响应头"));
        return;
      }
      const line = buf.split("\r\n")[0];
      const code = Number((line.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      if (code === 407) return fin(new Error("代理要求认证（407），请填用户名密码"));
      if (code !== 200) return fin(new Error(`HTTP 代理拒绝 CONNECT：${line.trim()}`));
      // 隧道里紧跟的任何残留字节都是目标数据，不能丢
      const rest = Buffer.from(buf.slice(buf.indexOf("\r\n\r\n") + 4), "latin1");
      fin(null);
      if (rest.length) sock.unshift(rest);
    }

    sock.on("error", onError);
    sock.on("data", onData);
    sock.once("connect", () => {
      const auth = cfg.user
        ? "Proxy-Authorization: Basic " + Buffer.from(`${cfg.user}:${cfg.pass || ""}`).toString("base64") + "\r\n"
        : "";
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}User-Agent: open-source-radar\r\n\r\n`);
    });
  });
}

export function directTunnel(cfg, host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`直连 ${host}:${port} 超时`)); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("error", (e) => { clearTimeout(timer); reject(new Error(`直连 ${host}:${port} 失败：${e.message}`)); });
  });
}

/* 按配置选一条路，统一返回一条「已经通到目标 host:port」的原始 socket。 */
export function openTunnel(cfg, host, port, timeoutMs) {
  if (!cfg) return directTunnel(null, host, port, timeoutMs);
  if (cfg.scheme === "http" || cfg.scheme === "https") return httpProxyTunnel(cfg, host, port, timeoutMs);
  return socks5Tunnel(cfg, host, port, timeoutMs);
}

/* 本地 CONNECT 桥：fetch 的 proxy 指向它，它负责用上游隧道转发。
 * 只听 127.0.0.1、随机端口，不对外暴露。 */
export function startBridge(cfg) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let closed = false;

    // https 目标：fetch 发 CONNECT，整条连接原样透传
    server.on("connect", (req, clientSock, head) => {
      clientSock.on("error", () => {});
      const [host, portStr] = String(req.url).split(":");
      const port = Number(portStr) || 443;
      openTunnel(cfg, host, port).then((up) => {
        up.on("error", () => clientSock.destroy());
        clientSock.on("close", () => up.destroy());
        clientSock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) up.write(head);
        up.pipe(clientSock);
        clientSock.pipe(up);
      }).catch((e) => {
        // CONNECT 分支同样要带 x-radar-proxy-error，否则出站层拦不到 https 目标的代理故障
        const body = Buffer.from(String(e.message), "utf8");
        clientSock.end(
          `HTTP/1.1 502 Bad Gateway\r\nx-radar-proxy-error: 1\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n` + body,
        );
      });
    });

    // http 目标：fetch 发绝对 URI，改写成 origin-form 后走隧道
    server.on("request", (req, res) => {
      let u;
      try { u = new URL(req.url); } catch { res.writeHead(400); return res.end("bad url"); }
      const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
      openTunnel(cfg, u.hostname, port).then((up) => {
        up.on("error", () => up.destroy());
        const hdrs = { ...req.headers, host: u.host };
        delete hdrs["proxy-authorization"];   // 本桥自己的认证信息不能漏给目标
        const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
        for (const [k, v] of Object.entries(hdrs)) {
          if (v === undefined) continue;
          lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
        }
        up.write(lines.join("\r\n") + "\r\n\r\n");
        req.pipe(up);
        up.pipe(res);
      }).catch((e) => {
        // 必须带 x-radar-proxy-error：出站层靠它区分「代理不通」与「目标返回 502」
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "x-radar-proxy-error": "1" });
          res.end(e.message);
        } else {
          res.destroy();
        }
      });
    });

    server.on("error", (e) => { if (!closed) reject(e); });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => { closed = true; return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

/* ---- 全局状态：配置变了一次就重建桥，请求方只管调 outboundFetch ---- */
let state = { cfg: null, key: "", bridge: null, pending: null };

const keyOf = (cfg) => (cfg ? `${cfg.scheme}|${cfg.host}|${cfg.port}|${cfg.user}|${cfg.pass}` : "");

/* 传入 null 表示不启用代理。返回 Promise<void>，可重复调用。 */
export async function configureProxy(cfg) {
  const k = keyOf(cfg);
  if (k === state.key && (state.bridge || !cfg)) return;
  const old = state.bridge;
  state = { cfg, key: k, bridge: null, pending: null };
  if (old) await old.close().catch(() => {});
  if (!cfg) return;
  state.bridge = await startBridge(cfg);
}

export function proxyStatus() {
  return {
    enabled: !!state.cfg,
    url: state.cfg?.url || "",
    display: state.cfg?.display || "",
    scheme: state.cfg?.scheme || "",
    bridge_port: state.bridge?.port || null,
  };
}

/* 所有出站请求的唯一出口。未启用代理时与裸 fetch 完全等价。 */
// 桥自己失败时返回 502 + text/plain，正文是原因。带上这个头，前端与出站层才能
// 区分「代理连不上」和「目标服务器返回 502」——后者不该被改写。
export const BRIDGE_ERR_HEADER = "x-radar-proxy-error";

// Bun 的失败信息是固定的英文句子，光看「Unable to connect. Is the computer able to access the url?」
// 分不出是目标挂了还是代理配错。这里补上「走的哪条路」和判断方向。
const CONN_ERR = /unable to connect|econnrefused|econnreset|fetch failed|etimedout|timed out|network is unreachable|enetunreach|ehostunreach|dns|getaddrinfo/i;
function wrapConnError(err, via) {
  const msg = String(err?.message || err || "");
  if (!CONN_ERR.test(msg)) return err;
  const e = new Error(`${via}失败：${msg}`);
  e.cause = err;
  return e;
}

export async function outboundFetch(url, init) {
  if (!state.cfg) {
    try {
      return await fetch(url, init);
    } catch (err) {
      throw wrapConnError(err, "直连（未配置代理）");
    }
  }
  if (!state.bridge) {
    // 并发进来时只建一座桥
    if (!state.pending) state.pending = startBridge(state.cfg).then((b) => { state.bridge = b; return b; });
    await state.pending;
  }
  // 用 127.0.0.1 而不是 localhost：某些环境 localhost 先解析到 ::1，Bun 不会回落
  let r;
  try {
    r = await fetch(url, { ...init, proxy: `http://127.0.0.1:${state.bridge.port}` });
  } catch (err) {
    throw wrapConnError(err, `代理 ${state.cfg.display} `);
  }
  // 桥打不通时不会抛，而是回一个 502；不拦下来用户看到的就是「GitHub 返回 502」，
  // 排查方向会完全跑偏。
  if (r.status === 502 && r.headers.get(BRIDGE_ERR_HEADER)) {
    // 桥的正文已经是「连不上代理 socks5://…：ECONNREFUSED」，外层再贴一遍代理地址
    // 就成了「代理 socks5://… 不可用：连不上代理 socks5://…」。这里只补上下文。
    throw new Error((await r.text().catch(() => "")).trim() || `代理 ${state.cfg.display} 返回 502`);
  }
  return r;
}

/* 自检：通过当前配置拉一次 GitHub 限流头，返回耗时与状态。
 * 用 GitHub 而不是随便找个站点，是因为它正好就是本工具最常出站的地方。 */
export async function testProxy(cfg, timeoutMs = 12000) {
  const saved = state;
  if (cfg) {
    if (keyOf(cfg) !== state.key) {
      // 用一份临时桥测，不污染正在用的配置
      const b = await startBridge(cfg);
      try {
        const t0 = Date.now();
        const r = await fetch("https://api.github.com/rate_limit", {
          proxy: `http://127.0.0.1:${b.port}`,
          headers: { "user-agent": "open-source-radar", accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        // 桥自己失败时回的是 502 + 纯文本原因，直接当成功会把「代理连不上」显示成绿色
        if (!r.ok) throw new Error((await r.text().catch(() => "")).trim() || `代理返回 HTTP ${r.status}`);
        return { ok: true, status: r.status, ms: Date.now() - t0 };
      } finally {
        await b.close().catch(() => {});
        state = saved;
      }
    }
  }
  const t0 = Date.now();
  const r = await outboundFetch("https://api.github.com/rate_limit", {
    headers: { "user-agent": "open-source-radar", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error((await r.text().catch(() => "")).trim() || `代理返回 HTTP ${r.status}`);
  return { ok: true, status: r.status, ms: Date.now() - t0 };
}
