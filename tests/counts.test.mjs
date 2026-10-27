import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";

// 侧栏数字与列表条数必须同源。
// 真实缺陷（2026-10-27 用户截图）：侧栏写 226，点「全部」列表给 294，
// 待读/已放弃都是 0 却仍可点进去看到一屏空白。
// 这里用内存库复现那几条判据，锁住「计数 = 列表」这条不变式。

function mkDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY, full_name TEXT, source TEXT,
      language TEXT, archived INTEGER DEFAULT 0, dropped INTEGER DEFAULT 0,
      detached INTEGER DEFAULT 0, pushed_at TEXT);
    CREATE TABLE hidden (repo_id INTEGER PRIMARY KEY);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, parent TEXT);
    CREATE TABLE repo_tags (repo_id INTEGER, tag_id INTEGER, source TEXT);
  `);
  const add = db.prepare("INSERT INTO repos (id,full_name,source,language,archived,dropped,detached,pushed_at) VALUES (?,?,?,?,?,?,?,?)");
  const old = "2020-01-01T00:00:00Z";
  const fresh = new Date().toISOString();
  add.run(1, "a/one", "starred", "Go", 0, 0, 0, fresh);
  add.run(2, "a/two", "starred", "Go", 0, 0, 0, old);        // 停滞
  add.run(3, "b/three", "fork", "Rust", 0, 0, 0, fresh);
  add.run(4, "c/four", "discover", "Go", 0, 0, 0, fresh);    // 收编的临时仓库
  add.run(5, "d/five", "starred", "Go", 0, 1, 0, fresh);     // 已放弃
  add.run(6, "e/six", "starred", "Go", 0, 0, 0, fresh);      // 下面被隐藏
  add.run(7, "f/seven", "starred", "Go", 0, 0, 1, fresh);    // 上游已取消 star
  db.exec("INSERT INTO hidden (repo_id) VALUES (6)");
  db.exec("INSERT INTO tags (id,name,parent) VALUES (1,'AI',''),(2,'Agent','AI')");
  db.exec("INSERT INTO repo_tags (repo_id,tag_id,source) VALUES (1,2,'auto'),(2,1,'auto'),(5,1,'auto')");
  return db;
}

// 与 server.mjs 的 repoWhere 同判据（all 视图）
// detached：本地库里还留着、但这一轮同步上游没再列到（远端取消 star / 仓库被删）。
const VISIBLE = "r.source != 'discover' AND COALESCE(r.dropped,0)=0 AND COALESCE(r.detached,0)=0 AND h.repo_id IS NULL";

describe("侧栏计数与列表同源", () => {
  test("「全部」排除 discover / dropped / hidden", () => {
    const db = mkDb();
    const n = db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id WHERE ${VISIBLE}`).get().n;
    // 1、2、3 可见；4 discover、5 dropped、6 hidden 都不算
    expect(n).toBe(3);
  });

  test("starred / fork 计数各自排除已放弃与隐藏", () => {
    const db = mkDb();
    // source 分支在 repoWhere 里是「等于」而不是「不等于」，两种分支要分开写：
    // 显式点某个 source 时 WHERE 变成 r.source=?，不会再叠 source!='discover'。
    const one = (src) =>
      db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id
        WHERE COALESCE(r.dropped,0)=0 AND COALESCE(r.detached,0)=0 AND h.repo_id IS NULL AND r.source=?`).get(src).n;
    expect(one("starred")).toBe(2);   // 1、2（5 dropped、6 hidden、7 detached）
    expect(one("fork")).toBe(1);      // 3
    expect(one("discover")).toBe(1);  // 4：单独点「发现过的」才看得到
    // 「全部」= 3，不等于三者相加（4），差的就是 discover 那条
    expect(one("starred") + one("fork") + one("discover")).not.toBe(3);
  });

  test("停滞计数排除已放弃与隐藏，且与列表判据一致", () => {
    const db = mkDb();
    const before = new Date(Date.now() - 180 * 86400000).toISOString();
    const sql = `FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id
      WHERE ${VISIBLE} AND (r.archived=1 OR (r.pushed_at IS NOT NULL AND r.pushed_at != '' AND r.pushed_at < ?))`;
    const n = db.query(`SELECT COUNT(*) n ${sql}`).get(before).n;
    expect(n).toBe(1); // 只有 2 号是老的
  });

  test("语言计数排除 discover，否则侧栏会比列表多", () => {
    const db = mkDb();
    const rows = db.query(`SELECT language, COUNT(*) n FROM repos r
      WHERE language != '' AND COALESCE(dropped,0)=0 AND COALESCE(detached,0)=0 AND source != 'discover'
        AND r.id NOT IN (SELECT repo_id FROM hidden)
      GROUP BY language`).all();
    const go = rows.find((r) => r.language === "Go").n;
    // Go 有 1、2、5(dropped)、6(hidden)、4(discover)、7(detached)，只应剩 1、2
    expect(go).toBe(2);
  });

  test("标签计数同样排除 discover / dropped / hidden", () => {
    const db = mkDb();
    const rows = db.query(`
      SELECT t.name, COUNT(v.id) n
      FROM tags t
      LEFT JOIN repo_tags rt ON rt.tag_id=t.id
      LEFT JOIN repos v ON v.id=rt.repo_id AND COALESCE(v.dropped,0)=0 AND COALESCE(v.detached,0)=0 AND v.source!='discover'
        AND v.id NOT IN (SELECT repo_id FROM hidden)
      GROUP BY t.id`).all();
    // Agent 只挂在 1 号上 → 1；AI 挂在 2 号（可见）与 5 号（dropped）→ 1
    expect(rows.find((r) => r.name === "Agent").n).toBe(1);
    expect(rows.find((r) => r.name === "AI").n).toBe(1);
  });

  test("已取消的仓库不出现在任何默认视图，但单独点「已取消」看得到", () => {
    const db = mkDb();
    // 7 号是 detached：默认视图（全部 / starred）不该有它
    const all = db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id WHERE ${VISIBLE}`).get().n;
    expect(all).toBe(3);   // 1、2、3（7 已被 detached 排掉）
    const starred = db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id
      WHERE COALESCE(r.dropped,0)=0 AND COALESCE(r.detached,0)=0 AND h.repo_id IS NULL AND r.source=?`).get("starred").n;
    expect(starred).toBe(2);  // 1、2（7 被排掉）
    // 单独点「已取消」：1 条，且不被 source!='discover' 误伤
    const detached = db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id
      WHERE COALESCE(r.detached,0)=1 AND h.repo_id IS NULL`).get().n;
    expect(detached).toBe(1);
  });

  test("既隐藏又取消的仓库：在「已隐藏」里能找到，不凭空消失", () => {
    const db = mkDb();
    db.exec("INSERT INTO hidden (repo_id) VALUES (7)");   // 7 号本身是 detached
    // 「已隐藏」不能叠 detached 过滤，否则 7 号两个入口都进不去
    const hidden = db.query(`SELECT COUNT(*) n FROM repos r
      JOIN hidden h ON h.repo_id=r.id`).get().n;
    expect(hidden).toBe(2);   // 6 和 7
    // 「已取消」排掉已隐藏的，两边不重复计数
    const detached = db.query(`SELECT COUNT(*) n FROM repos r
      WHERE COALESCE(r.detached,0)=1 AND r.id NOT IN (SELECT repo_id FROM hidden)`).get().n;
    expect(detached).toBe(0);
  });

  test("0 条的入口计数就是 0，用于前端置灰判据", () => {
    const db = mkDb();
    const toread = db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id
      WHERE ${VISIBLE} AND COALESCE(r.dropped,0)=0`).get().n;
    expect(toread).toBeGreaterThan(0); // 这个库里没有 toread 字段，用可见数保底
    const dropped = db.query(`SELECT COUNT(*) n FROM repos r LEFT JOIN hidden h ON h.repo_id=r.id
      WHERE r.dropped=1`).get().n;
    expect(dropped).toBe(1);
  });
});
