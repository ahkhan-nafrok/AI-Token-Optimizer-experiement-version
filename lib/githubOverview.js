// lib/githubOverview.js
// Pure, deterministic logic for the Project Knowledge Manager's account-level
// "GitHub Overview" additions: a current-month contribution calendar and a
// "recently pushed or created" repo list. Deliberately kept separate from
// projectStore.js — this data is account-level, not per-tracked-project, and
// never touches the `projects` storage key or any of its migration-safety
// rules. No network calls live here; fetching is lib/github.js's job,
// storage is projectsView.js's job. This file is fully unit-testable
// without a browser, chrome.storage, or a live GitHub token.

/** Zero-padded UTC date key, e.g. "2026-07-04". */
function toDateKey(year, monthIndex, day) {
  const mm = String(monthIndex + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * The current UTC calendar month as a [from, to) DateTime range for GraphQL,
 * plus a "monthKey" (e.g. "2026-07") used to detect month rollover. Always
 * derived from the real current time — a stored month is never trusted on
 * its own, only compared against this.
 */
export function getCurrentUtcMonthRange(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const from = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();
  const to = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0)).toISOString();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { year, month, from, to, monthKey };
}

/**
 * GraphQL query for the VIEWER's own contribution calendar over a date
 * range. Uses `viewer`, not `user(login: ...)` — the token itself identifies
 * whose data this is, so no separate GitHub username ever needs to be
 * stored or kept in sync.
 */
export const CONTRIBUTION_QUERY = `
  query($from: DateTime!, $to: DateTime!) {
    viewer {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

/**
 * Flatten a raw GraphQL contributionCalendar response into a flat
 * { "YYYY-MM-DD": { count } } map. Defensive: any malformed or missing
 * shape returns an empty map rather than throwing, so a bad/unexpected
 * response degrades to "no data shown" instead of crashing the popup.
 */
export function parseContributionCalendar(graphqlData) {
  const dayMap = {};
  const weeks = graphqlData?.viewer?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) return dayMap;

  for (const week of weeks) {
    const days = week?.contributionDays;
    if (!Array.isArray(days)) continue;
    for (const day of days) {
      if (!day?.date) continue;
      dayMap[day.date] = { count: day.contributionCount || 0 };
    }
  }
  return dayMap;
}

/**
 * Build the GitHub-style heatmap grid for a given month: an array of weeks
 * (columns, in chronological order), each a fixed length-7 array (Sun..Sat).
 * Days outside the month itself (padding before day 1, or after the last
 * day to complete the final week) are `null` — rendered as blank, never a
 * third contribution state. `contributed` is a plain boolean (count > 0) —
 * binary only, never a 4-shade intensity scale.
 */
export function buildMonthGrid(dayMap, monthRange) {
  const { year, month } = monthRange;
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0 = Sun
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = toDateKey(year, month, d);
    const entry = dayMap[dateKey];
    cells.push({ date: dateKey, day: d, contributed: !!(entry && entry.count > 0) });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * Is a stored contribution cache stale? True if there's no cache at all, or
 * its monthKey doesn't match the real current UTC month. This is what
 * drives automatic month-rollover refetch — opening the popup in a new
 * month refetches on its own; a manual refresh click is only needed to
 * re-check the current month's data mid-month.
 */
export function isCalendarCacheStale(cache, now = new Date()) {
  if (!cache || !cache.monthKey) return true;
  return cache.monthKey !== getCurrentUtcMonthRange(now).monthKey;
}

/**
 * Rank repos by "recently pushed OR created" — max(created_at, pushed_at)
 * per repo, descending, top `count`. A brand-new repo with no pushes yet
 * still surfaces if it's the most recently created thing on the account,
 * matching the "pushed or created" wording exactly rather than only using
 * GitHub's own pushed-only sort.
 */
export function rankRecentRepos(repos, count = 2) {
  if (!Array.isArray(repos)) return [];
  const withEffective = repos
    .filter((r) => r && r.full_name)
    .map((r) => {
      const created = r.created_at ? new Date(r.created_at).getTime() : 0;
      const pushed = r.pushed_at ? new Date(r.pushed_at).getTime() : 0;
      const effectiveAt = Math.max(created, pushed);
      return {
        name: r.name,
        fullName: r.full_name,
        htmlUrl: r.html_url || null,
        effectiveAt,
        effectiveIso: effectiveAt ? new Date(effectiveAt).toISOString() : null,
      };
    });
  withEffective.sort((a, b) => b.effectiveAt - a.effectiveAt);
  return withEffective.slice(0, count);
}
