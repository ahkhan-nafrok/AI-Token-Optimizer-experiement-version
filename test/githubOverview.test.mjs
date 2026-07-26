// test/githubOverview.test.mjs
// Pure logic tests for lib/githubOverview.js — no network, no chrome.storage.
// Run with: node test/githubOverview.test.mjs

import assert from "node:assert/strict";
import {
  getCurrentUtcMonthRange,
  parseContributionCalendar,
  buildMonthGrid,
  isCalendarCacheStale,
  rankRecentRepos,
} from "../lib/githubOverview.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.message}`);
  }
}

// ---------- getCurrentUtcMonthRange ----------

test("getCurrentUtcMonthRange: computes correct from/to/monthKey for a fixed mid-July date", () => {
  const now = new Date("2026-07-15T10:30:00Z");
  const range = getCurrentUtcMonthRange(now);
  assert.equal(range.year, 2026);
  assert.equal(range.month, 6, "month must be 0-indexed (July = 6)");
  assert.equal(range.monthKey, "2026-07");
  assert.equal(range.from, "2026-07-01T00:00:00.000Z");
  assert.equal(range.to, "2026-08-01T00:00:00.000Z", "'to' must be the exclusive start of the NEXT month");
});

test("getCurrentUtcMonthRange: handles December -> January year rollover correctly", () => {
  const now = new Date("2026-12-20T00:00:00Z");
  const range = getCurrentUtcMonthRange(now);
  assert.equal(range.monthKey, "2026-12");
  assert.equal(range.to, "2027-01-01T00:00:00.000Z", "December's 'to' boundary must roll into the next YEAR correctly");
});

// ---------- parseContributionCalendar ----------

test("parseContributionCalendar: flattens weeks/contributionDays into a flat date->count map", () => {
  const graphqlData = {
    viewer: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: [
            { contributionDays: [{ date: "2026-06-28", contributionCount: 0 }, { date: "2026-06-29", contributionCount: 3 }] },
            { contributionDays: [{ date: "2026-06-30", contributionCount: 0 }, { date: "2026-07-01", contributionCount: 5 }] },
          ],
        },
      },
    },
  };
  const map = parseContributionCalendar(graphqlData);
  assert.equal(map["2026-06-29"].count, 3);
  assert.equal(map["2026-07-01"].count, 5);
  assert.equal(map["2026-06-28"].count, 0);
  assert.equal(Object.keys(map).length, 4);
});

test("parseContributionCalendar: malformed/missing shape returns an empty map, never throws", () => {
  assert.deepEqual(parseContributionCalendar(null), {});
  assert.deepEqual(parseContributionCalendar({}), {});
  assert.deepEqual(parseContributionCalendar({ viewer: {} }), {});
  assert.deepEqual(parseContributionCalendar({ viewer: { contributionsCollection: { contributionCalendar: { weeks: "not-an-array" } } } }), {});
});

test("parseContributionCalendar: skips individual malformed day entries without dropping the whole response", () => {
  const graphqlData = {
    viewer: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: [{ contributionDays: [{ date: "2026-07-01", contributionCount: 2 }, { contributionCount: 9 }, null] }],
        },
      },
    },
  };
  const map = parseContributionCalendar(graphqlData);
  assert.equal(Object.keys(map).length, 1, "only the well-formed day entry should survive");
  assert.equal(map["2026-07-01"].count, 2);
});

// ---------- buildMonthGrid ----------

test("buildMonthGrid: July 2026 - correct weekday padding, day count, and binary contributed flags", () => {
  // Derive the real weekday independently of the implementation under test.
  const firstWeekday = new Date(Date.UTC(2026, 6, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(2026, 7, 0)).getUTCDate();

  const dayMap = {
    "2026-07-01": { count: 2 },
    "2026-07-02": { count: 0 },
    "2026-07-15": { count: 7 },
  };
  const range = { year: 2026, month: 6 };
  const weeks = buildMonthGrid(dayMap, range);

  const flatCells = weeks.flat();
  const leadingPadding = flatCells.slice(0, firstWeekday);
  assert.ok(leadingPadding.every((c) => c === null), "cells before day 1 must be null (blank), not a contribution state");

  const realDays = flatCells.filter((c) => c !== null);
  assert.equal(realDays.length, daysInMonth, "every day of the month must be represented exactly once");

  const day1 = flatCells.find((c) => c && c.date === "2026-07-01");
  assert.equal(day1.contributed, true, "count > 0 must be contributed=true");
  const day2 = flatCells.find((c) => c && c.date === "2026-07-02");
  assert.equal(day2.contributed, false, "count === 0 must be contributed=false");
  const day3 = flatCells.find((c) => c && c.date === "2026-07-03");
  assert.equal(day3.contributed, false, "a day with no dayMap entry at all must default to not-contributed, never crash");

  assert.equal(weeks.every((w) => w.length === 7), true, "every week/column must be exactly 7 cells (Sun..Sat)");
  const totalCells = weeks.length * 7;
  assert.equal(totalCells % 7, 0);
  assert.ok(totalCells >= firstWeekday + daysInMonth, "grid must have room for all padding + real days");
});

test("buildMonthGrid: trailing padding after the last day of the month is also null", () => {
  const range = { year: 2026, month: 6 }; // July 2026
  const weeks = buildMonthGrid({}, range);
  const flatCells = weeks.flat();
  const daysInMonth = new Date(Date.UTC(2026, 7, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(2026, 6, 1)).getUTCDay();
  const trailing = flatCells.slice(firstWeekday + daysInMonth);
  assert.ok(trailing.every((c) => c === null), "cells after the last real day must be null padding, not a contribution state");
});

test("buildMonthGrid: never produces a third contribution state — every non-null cell is a strict boolean", () => {
  const dayMap = { "2026-07-05": { count: 12 } };
  const weeks = buildMonthGrid(dayMap, { year: 2026, month: 6 });
  for (const cell of weeks.flat()) {
    if (cell !== null) assert.equal(typeof cell.contributed, "boolean");
  }
});

// ---------- isCalendarCacheStale ----------

test("isCalendarCacheStale: no cache at all is always stale", () => {
  assert.equal(isCalendarCacheStale(null), true);
  assert.equal(isCalendarCacheStale(undefined), true);
  assert.equal(isCalendarCacheStale({}), true, "a cache object with no monthKey must be treated as stale");
});

test("isCalendarCacheStale: same month as now is NOT stale", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  const cache = { monthKey: "2026-07" };
  assert.equal(isCalendarCacheStale(cache, now), false);
});

test("isCalendarCacheStale: a cache from a previous month IS stale (drives auto-refetch on month rollover)", () => {
  const now = new Date("2026-08-01T00:05:00Z");
  const cache = { monthKey: "2026-07" };
  assert.equal(isCalendarCacheStale(cache, now), true);
});

// ---------- rankRecentRepos ----------

test("rankRecentRepos: ranks by max(created_at, pushed_at), descending", () => {
  const repos = [
    { name: "old-active", full_name: "me/old-active", created_at: "2020-01-01T00:00:00Z", pushed_at: "2026-01-01T00:00:00Z" },
    { name: "brand-new", full_name: "me/brand-new", created_at: "2026-07-20T00:00:00Z", pushed_at: null },
    { name: "stale", full_name: "me/stale", created_at: "2019-01-01T00:00:00Z", pushed_at: "2019-06-01T00:00:00Z" },
  ];
  const ranked = rankRecentRepos(repos, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].name, "brand-new", "a never-pushed but just-created repo must outrank an older push");
  assert.equal(ranked[1].name, "old-active");
});

test("rankRecentRepos: respects the count limit", () => {
  const repos = Array.from({ length: 10 }, (_, i) => ({
    name: `r${i}`,
    full_name: `me/r${i}`,
    created_at: "2020-01-01T00:00:00Z",
    pushed_at: new Date(2026, 0, i + 1).toISOString(),
  }));
  const ranked = rankRecentRepos(repos, 2);
  assert.equal(ranked.length, 2);
});

test("rankRecentRepos: filters out malformed entries (missing full_name) rather than crashing", () => {
  const repos = [null, {}, { name: "ok", full_name: "me/ok", created_at: "2026-01-01T00:00:00Z", pushed_at: "2026-01-01T00:00:00Z" }];
  const ranked = rankRecentRepos(repos, 5);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, "ok");
});

test("rankRecentRepos: non-array input returns an empty array, never throws", () => {
  assert.deepEqual(rankRecentRepos(null), []);
  assert.deepEqual(rankRecentRepos(undefined), []);
  assert.deepEqual(rankRecentRepos("nope"), []);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
