#!/usr/bin/env python3
"""把 scripts/../data/mcp-cache.json 导入 radar.db（Bun 端另有 /api/sync 走 REST token 路径）。
SQLite 表结构与 server.mjs 保持一致；只写 code 层字段，不覆盖用户手工简介/标签。
"""
import json, os, sqlite3, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("RADAR_DB") or os.path.join(ROOT, "data", "radar.db")
SRC = os.environ.get("RADAR_SRC") or os.path.join(ROOT, "data", "mcp-cache.json")

TAGS = [
    (r"ppt|slide|presentation|keynote|powerpoint", "文档办公"),
    (r"excel|spreadsheet|xlsx|office|docx", "文档办公"),
    (r"pdf", "文档办公"),
    (r"note|obsidian|markdown|wiki|notion|knowledge", "知识管理"),
    (r"agent|langgraph|autogen|crew", "AI / Agent"),
    (r"llm|gpt|claude|qwen|deepseek|gemini|inference|vllm|ollama", "AI / 大模型"),
    (r"rag|embedding|vector|milvus|chroma|faiss", "RAG / 向量库"),
    (r"diffusion|stable-diffusion|comfyui|flux|sdxl", "AI 绘图"),
    (r"tts|voice|speech|whisper|audio|asr|music", "音频语音"),
    (r"video|ffmpeg|subtitle|remotion", "视频处理"),
    (r"docker|kubernetes|k8s|helm|compose", "容器 / 运维"),
    (r"nginx|proxy|reverse|tunnel|frp|wireguard|vpn|clash|sing-box|v2ray|xray", "网络代理"),
    (r"monitor|prometheus|grafana|uptime[-_]?monitor|alertmanager", "监控运维"),
    (r"nas|home-assistant|homelab|self-host|dashboard|unraid", "自托管"),
    (r"scrap|crawl|spider|puppeteer|playwright|selenium|browser", "爬虫自动化"),
    (r"chrome|extension|userscript|tampermonkey", "浏览器扩展"),
    (r"macos|swiftui|ios|iphone|uikit", "Apple 生态"),
    (r"android|adb|magisk|xposed|frida|root", "安卓逆向"),
    (r"decompil|ghidra|\bida\b|\bpwn\b|malware|reversing|逆向", "逆向分析"),
    (r"crypto|bitcoin|ethereum|blockchain|web3|wallet", "区块链"),
    (r"sql|database|postgres|mysql|sqlite|redis|mongo|orm", "数据库"),
    (r"terminal|shell|\bcli\b|\btui\b|command-line", "命令行工具"),
    (r"editor|vim|neovim|emacs|\bide\b", "编辑器 IDE"),
    (r"\bui\b|component|tailwind|react|vue|svelte|frontend|css", "前端 UI"),
    (r"\be2e\b|cypress|jest|vitest|test-framework|testing-framework", "测试工程"),
    (r"deploy|\bci\b|pipeline|devops", "CI/CD"),
    (r"security|vulnerab|\bcve\b|pentest|hack", "安全攻防"),
    (r"game|emulator|retro|steam", "游戏"),
    (r"download|magnet|torrent|\bbt\b|onedrive|aliyun|网盘", "下载网盘"),
    (r"translat|i18n|字幕", "翻译"),
    (r"ocr|识别|scan", "OCR"),
]

def fmt(n):
    n = n or 0
    return f"{n/1000:.1f}k".replace(".0k", "k") if n >= 1000 else str(n)

def rule_digest(r, topics):
    hay = " ".join(filter(None, [r.get("description") or "", " ".join(topics), r.get("name") or "", r.get("language") or ""])).lower()
    hits = [tag for pat, tag in TAGS if __import__("re").search(pat, hay)]
    tags = list(dict.fromkeys(hits))[:2]
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
