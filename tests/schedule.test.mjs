/* 自动同步时间计算的单测。
   这块最容易出的 bug 是「错过周期后不再同步」和「非法值把服务打挂」，
   两种都只在特定时刻或特定输入下才出现，所以边界必须钉死。 */
import { describe, expect, test } from "bun:test";
import {
  clampInterval, nextRunAt, msUntilNext, humanInterval,
  parseStamp, autoSyncRuntime,
  DEFAULT_INTERVAL_MIN, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN,
} from "../lib/schedule.mjs";

describe("clampInterval", () => {
  test("默认两小时", () => {
    expect(DEFAULT_INTERVAL_MIN).toBe(120);
  });
  test("合法值原样返回", () => {
    expect(clampInterval(120)).toBe(120);
    expect(clampInterval(30)).toBe(30);
    expect(clampInterval(1440)).toBe(1440);
  });
  test("低于下限收敛到 15（保护 GitHub 配额）", () => {
    expect(clampInterval(1)).toBe(MIN_INTERVAL_MIN);
    expect(clampInterval(14)).toBe(MIN_INTERVAL_MIN);
    expect(clampInterval(0)).toBe(DEFAULT_INTERVAL_MIN);   // 0 视为没填
  });
  test("高于上限收敛到 1440", () => {
    expect(clampInterval(99999)).toBe(MAX_INTERVAL_MIN);
  });
  test("非法输入回落默认值，不抛错", () => {
    for (const bad of [NaN, Infinity, -1, "abc", null, undefined, {}]) {
      expect(() => clampInterval(bad)).not.toThrow();
      expect(clampInterval(bad)).toBe(DEFAULT_INTERVAL_MIN);
    }
  });
  test("小数四舍五入成整数分钟", () => {
    expect(clampInterval(90.6)).toBe(91);
  });
});

describe("nextRunAt / msUntilNext", () => {
  const H = 3600 * 1000;

  test("从未同步过 → 立刻跑", () => {
    const now = 1_700_000_000_000;
    expect(nextRunAt(0, 120, now)).toBe(now);
    expect(msUntilNext(0, 120, now)).toBe(0);
    expect(nextRunAt(null, 120, now)).toBe(now);
  });

  test("未到点 → 返回上次 + 间隔", () => {
    const now = 1_700_000_000_000;
    const last = now - 30 * 60 * 1000;          // 半小时前同步过，间隔 2 小时
    expect(nextRunAt(last, 120, now)).toBe(last + 2 * H);
    expect(msUntilNext(last, 120, now)).toBe(90 * 60 * 1000);
  });

  test("刚好到点 → 立刻", () => {
    const now = 1_700_000_000_000;
    expect(nextRunAt(now - 2 * H, 120, now)).toBe(now);
  });

  test("错过多个周期 → 立刻补，不顺延（否则重启后永远不同步）", () => {
    const now = 1_700_000_000_000;
    const last = now - 10 * H;                  // 错过了 5 个周期
    expect(nextRunAt(last, 120, now)).toBe(now);
    expect(msUntilNext(last, 120, now)).toBe(0);
  });

  test("间隔被改小后，可能立刻到点", () => {
    const now = 1_700_000_000_000;
    const last = now - 50 * 60 * 1000;          // 50 分钟前
    expect(msUntilNext(last, 120, now)).toBe(70 * 60 * 1000);
    expect(msUntilNext(last, 15, now)).toBe(0); // 改成 15 分钟后已经过了
  });

  test("非法间隔按默认值算，返回值仍是有限数", () => {
    const now = 1_700_000_000_000;
    const last = now - 30 * 60 * 1000;
    const v = nextRunAt(last, "abc", now);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(last + 2 * H);               // 回落到默认 120 分钟
  });
});

describe("humanInterval", () => {
  test("分钟级", () => {
    expect(humanInterval(15)).toBe("15 分钟");
    expect(humanInterval(30)).toBe("30 分钟");
  });
  test("整小时", () => {
    expect(humanInterval(60)).toBe("1 小时");
    expect(humanInterval(120)).toBe("2 小时");
    expect(humanInterval(1440)).toBe("24 小时");
  });
  test("非整小时", () => {
    expect(humanInterval(90)).toBe("1 小时 30 分钟");
  });
});

/* 这一组是回归测试：库里存的是 ISO 字符串，早先用 Number() 解析得到 NaN→0，
   调度器误判「从未同步」导致失败后每 5 秒重试一次（实测复现过）。 */
describe("parseStamp", () => {
  const ISO = "2026-10-27T14:34:51.545Z";
  const MS = Date.parse(ISO);

  test("ISO 字符串按 Date.parse 解析（不是 Number）", () => {
    expect(parseStamp(ISO)).toBe(MS);
    // 反面证据：证明 Number() 确实会坏，注释里那个坑是真的
    expect(Number(ISO)).toBeNaN();
  });

  test("纯数字串按毫秒时间戳读", () => {
    expect(parseStamp("1793110990382")).toBe(1793110990382);
    expect(parseStamp("0")).toBe(0);
  });

  test("数字原样返回", () => {
    expect(parseStamp(1793110990382)).toBe(1793110990382);
  });

  test("空值/非法值一律 0，不抛错", () => {
    for (const v of [null, undefined, "", "abc", "2026-13-45", NaN, Infinity, {}]) {
      expect(() => parseStamp(v)).not.toThrow();
      expect(parseStamp(v)).toBe(0);
    }
  });
});

describe("autoSyncRuntime", () => {
  const now = 1_700_000_000_000;
  const iso = (ms) => new Date(ms).toISOString();

  test("从未同步过 → next_run_at 是现在（立刻跑一次）", () => {
    const r = autoSyncRuntime({ ok: null, attempt: null, interval: 120, nowMs: now });
    expect(r.last_ok).toBe(0);
    expect(r.next_run_at).toBe(now);
  });

  test("ISO 字符串的成功时间能正确算出下次时刻（防 Number() 回归）", () => {
    const lastOk = now - 30 * 60 * 1000;             // 半小时前，间隔 2 小时
    const r = autoSyncRuntime({ ok: iso(lastOk), attempt: null, interval: 120, nowMs: now });
    expect(r.last_ok).toBe(lastOk);
    expect(r.next_run_at).toBe(lastOk + 120 * 60 * 1000);
  });

  test("失败时间参与基准，避免失败后忙循环", () => {
    const lastTry = now - 2 * 60 * 1000;             // 两分钟前失败过一次
    const r = autoSyncRuntime({ ok: null, attempt: iso(lastTry), interval: 15, nowMs: now });
    expect(r.next_run_at).toBe(lastTry + 15 * 60 * 1000);   // 不是 now，也不是 now+5s
    expect(r.next_run_at - now).toBeGreaterThan(0);
  });

  test("成功时间比失败时间新时取成功时间", () => {
    const ok = now - 1000;
    const tryAt = now - 10 * 60 * 1000;
    const r = autoSyncRuntime({ ok: iso(ok), attempt: iso(tryAt), interval: 60, nowMs: now });
    expect(r.next_run_at).toBe(ok + 60 * 60 * 1000);
  });

  test("last_error 原样透出，没有时空串", () => {
    expect(autoSyncRuntime({ interval: 60, nowMs: now }).last_error).toBe("");
    expect(autoSyncRuntime({ error: "401 Bad credentials", interval: 60, nowMs: now }).last_error)
      .toBe("401 Bad credentials");
  });
});
