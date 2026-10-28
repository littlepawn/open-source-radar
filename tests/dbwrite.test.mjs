import { describe, expect, test } from "bun:test";

// 这组测试保护「写库不再阻塞事件循环」这条性质。
// 它的价值不是测 SQLite 本身，而是防止后人把分块事务改回裸 for 循环。
//
// 关键判据（本机 APFS 实测）：500 条 × 5 语句
//   逐条隐式提交 → 事件循环阻塞 28ms（慢盘 synchronous=FULL 时 330ms）
//   分块事务     → 阻塞 1~3ms
// 所以只要分块实现存在且块间真的让出，阻塞就必须是「个位数毫秒」。

const { Database } = require("bun:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-dbwrite-"));
  const file = path.join(dir, `${name}.db`);
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, full_name TEXT);");
  return { db, dir, file };
}

// 与 server.mjs 的 writeChunked 同构：块内一个事务，块间 await Bun.sleep(0)
const WRITE_CHUNK = 50;
async function writeChunked(db, items, fn) {
  for (let i = 0; i < items.length; i += WRITE_CHUNK) {
    const chunk = items.slice(i, i + WRITE_CHUNK);
    db.transaction(() => {
      for (const item of chunk) fn(item);
    })();
    await Bun.sleep(0);
  }
}

function makeTimer() {
  let maxLag = 0;
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - last - 5);
    last = now;
  }, 5);
  return {
    async reset() { await Bun.sleep(30); last = Date.now(); maxLag = 0; },
    async stop() { await Bun.sleep(60); clearInterval(t); return maxLag; },
  };
}

describe("writeChunked：分块事务不阻塞事件循环", () => {
  test("500 条写入被切成 10 块，每块一次事务", async () => {
    const { db, dir } = tmpDb("chunks");
    const ins = db.prepare("INSERT INTO repos VALUES (?,?)");
    const txns = [];
    const orig = db.transaction.bind(db);
    db.transaction = (fn) => { txns.push(1); return orig(fn); };

    const items = Array.from({ length: 500 }, (_, i) => [i, `o${i}/r${i}`]);
    await writeChunked(db, items, ([id, name]) => ins.run(id, name));

    expect(txns.length).toBe(10);                       // 500 / 50
    expect(db.query("SELECT count(*) n FROM repos").get().n).toBe(500);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("事件循环阻塞个位数毫秒（回归保护：改回裸 for 会退化到数十毫秒）", async () => {
    const { db, dir } = tmpDb("lag");
    const ins = db.prepare("INSERT INTO repos VALUES (?,?)");
    const items = Array.from({ length: 500 }, (_, i) => [i, `owner${i}/repo-${i}`]);

    const timer = makeTimer();
    await timer.reset();
    await writeChunked(db, items, ([id, name]) => ins.run(id, name));
    const lag = await timer.stop();

    expect(lag).toBeLessThan(20);   // 实测 1~3ms；逐条提交为 28ms
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("块内某条失败只回滚该条，其余照常写入（与逐条提交语义一致）", async () => {
    const { db, dir } = tmpDb("err");
    db.exec("CREATE TABLE strict_t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);");
    const ins = db.prepare("INSERT INTO strict_t VALUES (?,?)");
    const items = [[1, "a"], [2, null], [3, "c"]];
    const failed = [];

    await writeChunked(db, items, ([id, v]) => {
      try { ins.run(id, v); } catch (e) { failed.push(id); }
    });

    expect(failed).toEqual([2]);
    expect(db.query("SELECT id FROM strict_t ORDER BY id").all().map((r) => r.id)).toEqual([1, 3]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("空数组不建事务、不报错", async () => {
    const { db, dir } = tmpDb("empty");
    let txnCount = 0;
    const orig = db.transaction.bind(db);
    db.transaction = (fn) => { txnCount++; return orig(fn); };
    await writeChunked(db, [], () => {});
    expect(txnCount).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("PRAGMA 配置", () => {
  test("WAL 下 synchronous 为 NORMAL（1），busy_timeout 被显式设置", () => {
    const { db, dir, file } = tmpDb("pragma");
    // 与 server.mjs 初始化顺序一致
    db.exec("PRAGMA synchronous=NORMAL;");
    db.exec("PRAGMA busy_timeout=5000;");
    expect(db.query("PRAGMA synchronous").get().synchronous).toBe(1);
    expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(5000);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("另一连接持写锁时，busy_timeout 让它等满再报错，而不是立刻 SQLITE_BUSY", () => {
    const { db, dir } = tmpDb("busy");
    // 用 400ms 而不是 5000ms，避免测试拖 5s；判据是「等了接近 400ms」
    db.exec("PRAGMA busy_timeout=400;");
    const db2 = new Database(db.query("PRAGMA database_list").get().file, { readwrite: true });
    db2.exec("PRAGMA busy_timeout=400;");
    db2.exec("BEGIN IMMEDIATE;");           // db2 持有写锁

    const t0 = performance.now();
    let threw = null;
    try { db.exec("INSERT INTO repos VALUES (999,'x/y')"); } catch (e) { threw = e; }
    const waited = performance.now() - t0;

    db2.exec("ROLLBACK;");
    // 关键断言：确实等过（不是 0ms 立刻失败），说明 busy_timeout 生效
    expect(waited).toBeGreaterThan(300);
    expect(threw?.message || "").toContain("database is locked");
    db.close();
    db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
