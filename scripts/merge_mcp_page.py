#!/usr/bin/env python3
"""通过 MCP github 工具（真实登录态）分页抓取 starred / forks，落盘 JSON。
用法（在会话内由 agent 调用 MCP 工具后拼接）：本文件只做去重合并 + 断点续传记录。
"""
import json, os, sys

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "mcp-cache.json")

def main():
    # stdin: JSON 数组（新一页 repo 对象，GitHub REST 原样字段）
    page = json.load(sys.stdin)
    if not isinstance(page, list):
        print("expect JSON array on stdin", file=sys.stderr); sys.exit(2)
    db = {"repos": {}}
    if os.path.exists(OUT):
        db = json.load(open(OUT))
    n = 0
    for r in page:
        key = r.get("full_name") or r.get("name")
        if not key: continue
        db["repos"][key] = r
        n += 1
    json.dump(db, open(OUT, "w"), ensure_ascii=False)
    print(f"merged {n}, total {len(db['repos'])}")

if __name__ == "__main__":
    main()
