// lib/githubOverview.js
// Pure logic layer for the two "GitHub Overview" additions to the Project
// Knowledge Manager: the Contribution Calendar and Recently Pushed list.
//
// Deliberately separate from lib/github.js (which only fetches raw facts)
// and from lib/projectStore.js (untouched — these are account-level facts,
// not per-tracked-project facts, so they don't belong in the `projects`
// storage key at all). No network calls, no chrome.storage calls — fully
// unit-testable in plain Node, same philosophy as lib/skeletonizer.js.

export const CALENDAR_CACHE_KEY = "ghContributionCache";
export const RECENT_REPOS_CACHE_KEY = "ghRecentRepos";
export const RECENT_REPOS_COUNT = 2;
// How many candidates to pull from /user/repos before ranking down to
// RECENT_REPOS_COUNT — GitHub's own `sort=pushed` ordering is usually enough,
// but re-ranking locally by max(created_at, pushed_at) needs a small buffer
// in case a very-recently-created-but-not-yet-pushed repo sits outside
// GitHub's pushed-sort window.
export const RECENT_REPOS_FETCH_COUNT = 10;

/** "YYYY-MM" for a date's UTC calendar month — the single source of truth
 * for "what month is this," used consistently for both the GraphQL query
 * range and the staleness/rollover check below. */
export function getUTCMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** UTC calendar-month boundaries as ISO datetime strings: [from, to), i.e.
 * from 00:00:00 UTC on the 1st through (exclusive) 00:00:00 UTC on the 1st
 * of the following month. Matches GitHub's own UTC-day bucketing so results
 * line up with what github.com's real contribution graph would show. */
export function getUTCMonthRange(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();
  const to = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0)).toISOString();
  return { from, to, monthKey: getUTCMonthKey(date) };
}

/**
 * A cached calendar is stale ONLY when its stored month no longer matches
 * the real current UTC month — this is the automatic-rollover rule, and it
 * is intentionally independent of the "manual refresh only" rule that
 * governs same-month re-fetches. A missing/malformed cache is always stale.
 */
export function isCalendarStale(cache, now = new Date()) {
  if (!cache || typeof cache.monthKey !== "string") return true;
  return cache.monthKey !== getUTCMonthKey(now);
}

/**
 * Normalize raw GraphQL `weeks` into a render-ready grid. Binary only —
 * `contributed` is a plain boolean (count > 0), never a 4-shade intensity
 * value. `inMonth` distinguishes real days-in-this-month from the padding
 * days GitHub includes to keep every week a full Sun–Sat column; padding
 * days render blank, never a third visual state.
 */
export function normalizeCalendarWeeks(weeks, monthKey) {
  return (weeks || []).map((week) => ({
    contributionDays: (week.contributionDays || []).map((day) => ({
      date: day.date,
      contributed: (day.contributionCount || 0) > 0,
      inMonth: typeof day.date === "string" && day.date.slice(0, 7) === monthKey,
    })),
  }));
}

/**
 * Rank candidate repos for "Recently Pushed": sort by max(created_at,
 * pushed_at) descending, keep the top `count`. A brand-new repo with no
 * pushes yet still surfaces correctly, since created_at alone can win the
 * comparison against an older repo's pushed_at.
 */
export function rankRecentRepos(repos, count = RECENT_REPOS_COUNT) {
  return (repos || [])
    .map((r) => {
      const activityAt = maxDate(r.created_at, r.pushed_at);
      return {
        name: r.name,
        full_name: r.full_name || r.name,
        html_url: r.html_url || null,
        created_at: r.created_at || null,
        pushed_at: r.pushed_at || null,
        activityAt,
      };
    })
    .sort((a, b) => toTime(b.activityAt) - toTime(a.activityAt))
    .slice(0, count);
}

function maxDate(a, b) {
  const at = toTime(a);
  const bt = toTime(b);
  if (at === -Infinity && bt === -Infinity) return null;
  return at >= bt ? a : b;
}

function toTime(v) {
  if (!v) return -Infinity;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}