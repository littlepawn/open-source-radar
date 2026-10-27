/* lib/insight.mjs 的单元测试：停滞判定、清理建议、fork 落后、相似度。
   这四个函数直接决定「要不要提示用户弃坑」，判据错一次就会误伤一批正常仓库，
   所以每个 test 都对着一个具体的信号组合，而不是随手写个「返回真值」。 */
import { describe, expect, test } from "bun:test";
import { stagnation, cleanupCandidates, forkLag, forkLagText, similarity, similarTo } from "../lib/insight.mjs";

const DAY = 86400000;
const nowMs = Date.parse("2026-10-27T00:00:00Z");
const daysAgo = (d) => new Date(nowMs - d * DAY).toISOString();

const repo = (o = {}) => ({
  id: 1, full_name: "o/r", archived: 0, pushed_at: daysAgo(10), open_count: 5,
  dropped: 0, stars: 100, language: "Go", topics: [], ...o,
});

describe("stagnation", () => {
  test("最近推送过的仓库不算停滞", () => {
    const s = stagnation(repo(), nowMs);
    expect(s.stale).toBe(false);
    expect(s.pushedAgo).toBe(10);
  });
  test("超过 180 天判为停滞", () => {
    const s = stagnation(repo({ pushed_at: daysAgo(200) }), nowMs);
    expect(s.stale).toBe(true);
    expect(s.pushedAgo).toBe(200);
  });
  test("归档一律算停滞，哪怕昨天才推送", () => {
    const s = stagnation(repo({ archived: 1, pushed_at: daysAgo(1) }), nowMs);
    expect(s.stale).toBe(true);
  });
  test("没有 pushed_at 时不算停滞（无法判断 ≠ 已死）", () => {
    expect(stagnation(repo({ pushed_at: null }), nowMs).stale).toBe(false);
    expect(stagnation(repo({ pushed_at: "" }), nowMs).stale).toBe(false);
  });
  test("阈值可调，边界是大于等于", () => {
    // 实现用 >=：正好到阈值就算停滞，与 repoList 的 SQL 过滤保持一致
    expect(stagnation(repo({ pushed_at: daysAgo(30) }), nowMs, { idleDays: 20 }).stale).toBe(true);
    expect(stagnation(repo({ pushed_at: daysAgo(30) }), nowMs, { idleDays: 30 }).stale).toBe(true);
    expect(stagnation(repo({ pushed_at: daysAgo(30) }), nowMs, { idleDays: 31 }).stale).toBe(false);
  });
});

describe("cleanupCandidates", () => {
  test("只命中一条信号的不进候选（避免误伤）", () => {
    const rows = [repo({ id: 1, pushed_at: daysAgo(400) })];   // 仅「长期没推送」
    expect(cleanupCandidates(rows, nowMs)).toHaveLength(0);
  });
  test("两条信号才进候选，并带上可读的命中原因", () => {
    // 「收了从没打开」的判据是 starred_at 超过 N 天且 open_count 为 0，
    // 只传 open_count=0 不构成信号（新收藏本来就没打开过）
    const rows = [repo({ id: 2, pushed_at: daysAgo(400), open_count: 0, starred_at: daysAgo(400) })];
    const out = cleanupCandidates(rows, nowMs, { idleDays: 365, neverOpenedDays: 180 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
    expect(out[0].signals.length).toBeGreaterThanOrEqual(2);
    for (const s of out[0].signals) expect(typeof s).toBe("string");
  });
  test("已放弃 + 已归档也算两条", () => {
    const rows = [repo({ id: 3, archived: 1, dropped: 1, pushed_at: daysAgo(5), open_count: 9 })];
    expect(cleanupCandidates(rows, nowMs)).toHaveLength(1);
  });
  test("健康仓库不入候选", () => {
    const rows = [repo({ id: 4, pushed_at: daysAgo(3), open_count: 12 })];
    expect(cleanupCandidates(rows, nowMs)).toHaveLength(0);
  });
  test("空列表不抛错", () => {
    expect(cleanupCandidates([], nowMs)).toHaveLength(0);
  });
});

describe("forkLag", () => {
  test("behind / ahead 直接取 API 字段", () => {
    expect(forkLag({ behind_by: 12, ahead_by: 3, status: "diverged" })).toMatchObject({ behind: 12, ahead: 3, status: "diverged" });
  });
  test("完全一致", () => {
    expect(forkLag({ behind_by: 0, ahead_by: 0, status: "identical" })).toMatchObject({ behind: 0, ahead: 0, status: "identical" });
  });
  test("没有响应时标记 unknown，不瞎猜 0", () => {
    const l = forkLag(null);
    expect(l.status).toBe("unknown");
    expect(l.behind).toBeNull();
  });
  test("文字描述能覆盖三种状态", () => {
    expect(forkLagText({ behind: 5, ahead: 0, status: "behind" })).toContain("5");
    expect(forkLagText({ behind: 0, ahead: 0, status: "identical" })).toContain("一致");
    // unknown 刻意返回空串：卡片上不显示角标，比显示「未知」更干净
    expect(forkLagText({ behind: null, ahead: null, status: "unknown" })).toBe("");
  });
});

describe("similarity / similarTo", () => {
  const a = { id: 1, language: "Go", topics: ["kv", "database"], tags: ["数据库"] };
  test("topics 传 JSON 字符串与数组等价", () => {
    const b1 = { id: 2, language: "Go", topics: '["kv","database"]', tags: ["数据库"] };
    const b2 = { id: 2, language: "Go", topics: ["kv", "database"], tags: ["数据库"] };
    expect(similarity(a, b1)).toBeCloseTo(similarity(a, b2), 6);
  });
  test("完全相同得满分以上（同语言再加权）", () => {
    expect(similarity(a, { ...a, id: 3 })).toBeGreaterThan(3);
  });
  test("毫无交集为 0", () => {
    expect(similarity(a, { id: 4, language: "Rust", topics: ["gui"], tags: ["前端"] })).toBe(0);
  });
  test("标签权重高于 topics", () => {
    const tagOnly = { id: 5, language: "", topics: [], tags: ["数据库"] };
    const topicOnly = { id: 6, language: "", topics: ["database"], tags: [] };
    expect(similarity(a, tagOnly)).toBeGreaterThan(similarity(a, topicOnly));
  });
  test("similarTo 排除自身、按分数降序、尊重 limit", () => {
    const rows = [
      a,
      { id: 7, language: "Go", topics: ["kv"], tags: ["数据库"] },        // 高分
      { id: 8, language: "Rust", topics: ["gui"], tags: ["前端"] },      // 0 分
      { id: 9, language: "Go", topics: ["database"], tags: [] },        // 中分
    ];
    const out = similarTo(a, rows, 2);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.id)).not.toContain(1);
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
  });
  test("分数为 0 的不返回（不硬凑五条）", () => {
    expect(similarTo(a, [a, { id: 10, language: "Rust", topics: [], tags: [] }], 5)).toHaveLength(0);
  });
});

  test("tags 是 JSON 字符串时也走归一化（不能只给 topics 做）", () => {
    // 库里 tags 与 topics 同样是 JSON 字符串。只给 topics 走 asList 的话，
    // new Set('["a"]') 会按字符集合算 Jaccard，相似度全乱。
    const a = { topics: '["go","cli"]', tags: '["命令行工具"]' };
    const b = { topics: '["go","cli"]', tags: '["命令行工具"]' };
    // similarity 是加权和（不是 0-1），只要「同标签得分严格高于异标签」即可
    expect(similarity(a, b)).toBeGreaterThan(0);
    // 不同标签不应被当成完全相同
    const c = { topics: '["go","cli"]', tags: '["视频处理"]' };
    expect(similarity(a, c)).toBeLessThan(similarity(a, b));
  });

  test("forkLag：字段缺失不臆造方向", () => {
    // behind_by 为 null 时不能被 ?? 0 顶成 0 —— 那会判成「领先上游 3」，
    // 而上游根本没给这个数，我们不知道它落后多少。
    expect(forkLag({ behind_by: null, ahead_by: 3 }).status).toBe("unknown");
    expect(forkLag({ behind_by: 5, ahead_by: null }).status).toBe("unknown");
    expect(forkLag({ behind_by: 5, ahead_by: 0 }).status).toBe("behind");
    expect(forkLag({ behind_by: 0, ahead_by: 3 }).status).toBe("ahead");
  });

  test("similarity：只同语言不该得分", () => {
    const a = { topics: [], tags: [], language: "Go" };
    expect(similarity(a, { topics: [], tags: [], language: "Go" })).toBe(0);
  });
