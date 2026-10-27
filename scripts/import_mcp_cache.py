#!/usr/bin/env python3
"""把 scripts/../data/mcp-cache.json 导入 radar.db（Bun 端另有 /api/sync 走 REST token 路径）。
SQLite 表结构与 server.mjs 保持一致；只写 code 层字段，不覆盖用户手工简介/标签。
"""
import json, os, sqlite3, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("RADAR_DB") or os.path.join(ROOT, "data", "radar.db")
SRC = os.environ.get("RADAR_SRC") or os.path.join(ROOT, "data", "mcp-cache.json")

# 规则表不再手抄一份：由 scripts/gen-rules.mjs 从 lib/rules.mjs 生成到 scripts/rules.json。
# 早先这里的 TAGS 是自己维护的 31 条，rag/pdf 裸写（rag 会命中 d**rag**on）、
# 标签上限写 [:2] 而 lib 是 [:3]，导致离线导入的库和在线同步的库标签对不上。
RULES_PATH = os.path.join(ROOT, "scripts", "rules.json")
if os.path.exists(RULES_PATH):
    with open(RULES_PATH, encoding="utf-8") as f:
        _rj = json.load(f)
    TAGS = [(r["source"] if isinstance(r, dict) else r[0], r["tag"] if isinstance(r, dict) else r[2])
            for r in _rj["rules"]]
else:
    # 没生成过 rules.json 就别静默用错规则，直接说清楚
    raise SystemExit("缺少 scripts/rules.json，先跑：bun scripts/gen-rules.mjs")

def fmt(n):
    n = n or 0
    return f"{n/1000:.1f}k".replace(".0k", "k") if n >= 1000 else str(n)

def rule_digest(r, topics):
    hay = " ".join(filter(None, [r.get("description") or "", " ".join(topics), r.get("name") or "", r.get("language") or ""])).lower()
    hits = [tag for pat, tag in TAGS if __import__("re").search(pat, hay)]
    tags = list(dict.fromkeys(hits))[:3]   # 与 lib/rules.mjs 的 ruleDigest 一致（早先是 [:2]，会少一个标签）
    desc = (r.get("description") or "").strip()
    cjk = any("\u4e00" <= ch <= "\u9fa5" for ch in desc)
    if tags:
        head = ("【" + " / ".join(tags) + "】") if cjk else ("归类：" + "、".join(tags) + "。")
        if desc:
            head += desc[:130] + ("…" if len(desc) > 130 else "")
    elif desc:
        head = desc[:140] + ("…" if len(desc) > 140 else "")
    else:
        head = "暂无描述，打开 README 看原文。"
    tail = f"{r.get('language') or '未知语言'} · ⭐ {fmt(r.get('stargazers_count'))} · 最后推送 {(r.get('pushed_at') or '')[:10]}"
    return head + "\n" + tail, tags

def main():
    if not os.path.exists(SRC):
        sys.exit("缺少 data/mcp-cache.json")
    data = json.load(open(SRC))
    con = sqlite3.connect(DB)
    cur = con.cursor()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # 复用 server.mjs 建好的表；若不存在则报错（保持单一 schema 来源）
    try:
        cur.execute("SELECT 1 FROM repos LIMIT 1")
    except sqlite3.OperationalError:
        sys.exit("radar.db 缺表，请先启动一次 server.mjs")
    tag_id = {}
    for name, in cur.execute("SELECT name FROM tags"):
        row = cur.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
        tag_id[name] = row[0]

    n = 0
    for key, r in data["repos"].items():
        topics = r.get("topics") or []
        src = "fork" if r.get("fork") else "starred"
        digest, tags = rule_digest(r, topics)
        cur.execute("""
        INSERT INTO repos (id, full_name, owner, name, html_url, description, homepage, language, topics,
          stars, forks, issues, watchers, size_kb, license, archived, is_fork, created_at, pushed_at,
          starred_at, source, digest, digest_src, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          description=excluded.description, language=excluded.language, topics=excluded.topics,
          stars=excluded.stars, forks=excluded.forks, issues=excluded.issues, size_kb=excluded.size_kb,
          license=excluded.license, archived=excluded.archived, pushed_at=excluded.pushed_at,
          homepage=excluded.homepage, fetched_at=excluded.fetched_at,
          digest=CASE WHEN repos.digest_src IN ('manual','ai') THEN repos.digest ELSE excluded.digest END
        """, (
            r["id"], r["full_name"], (r.get("owner") or {}).get("login"), r.get("name"),
            r.get("html_url"), r.get("description") or "", r.get("homepage") or "",
            r.get("language") or "", json.dumps(topics, ensure_ascii=False),
            r.get("stargazers_count") or 0, r.get("forks_count") or 0, r.get("open_issues_count") or 0,
            r.get("subscribers_count") or r.get("watchers_count") or 0, r.get("size") or 0,
            (r.get("license") or {}).get("spdx_id") or "", 1 if r.get("archived") else 0,
            1 if r.get("fork") else 0, r.get("created_at") or "", r.get("pushed_at") or "",
            r.get("starred_at"), src, digest, "rule", now))
        n += 1
        for t in tags:
            if t not in tag_id:
                cur.execute("INSERT INTO tags (name, kind) VALUES (?, 'auto')", (t,))
                tag_id[t] = cur.lastrowid
            cur.execute("INSERT OR IGNORE INTO repo_tags (repo_id, tag_id, source) VALUES (?,?, 'auto')",
                        (r["id"], tag_id[t]))
        if n % 200 == 0:
            con.commit()
    con.commit()
    total = cur.execute("SELECT COUNT(*) FROM repos").fetchone()[0]
    print(f"导入 {n} 条，库内共 {total} 条")

if __name__ == "__main__":
    main()
