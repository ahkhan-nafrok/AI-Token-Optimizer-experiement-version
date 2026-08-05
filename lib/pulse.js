// lib/pulse.js
// Pure, deterministic logic for Tab 1 (Pulse): a rolling-last-12-months
// contribution calendar (matching GitHub's own default profile view, not a
// calendar-year window) and a "current streak" calculation. No network
// calls live here — fetching is lib/github.js's job (ghGraphQL), storage is
// pulseView.js's job. Fully unit-testable without a browser or a live token.
//
// Replaces the old lib/githubOverview.js, which was scoped to a single
// current UTC month. That file's shape (GraphQL query, parseContribution-
// Calendar day-flattening) is preserved where it still applies; the
// month-grid-building and month-based staleness functions are replaced with
// rolling-range equivalents.

/** Zero-padded UTC date key, e.g. "2026-07-04". */
export function toDateKeyUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Rolling last-12-months range ending today (UTC), as a [from, to)
 * DateTime range for GraphQL — matches GitHub's own default profile view.
 * `to` is exclusive and set to the start of tomorrow so today is included.
 */
export function getRolling12MonthRange(now = new Date()) {
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(todayUTC);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  from.setUTCDate(from.getUTCDate() + 1); // inclusive 365/366-day window ending today

  const to = new Date(todayUTC);
  to.setUTCDate(to.getUTCDate() + 1); // exclusive upper bound = start of tomorrow

  return { from: from.toISOString(), to: to.toISOString(), asOfDateKey: toDateKeyUTC(todayUTC) };
}

/** Same shape as before — viewer's own contribution calendar over a date range. */
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
 * shape returns an empty map rather than throwing.
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
 * Builds the heatmap grid directly from GitHub's own week structure in the
 * raw GraphQL response — GitHub already returns weeks aligned Sun..Sat for
 * exactly the requested range, so there's no need to recompute month
 * boundaries by hand (unlike the old single-month version). Each week is a
 * length-7 array; days outside the actual data (shouldn't normally happen
 * within GitHub's own response, but defensively handled) are `null`.
 * `contributed` is a plain boolean (count > 0) — binary only.
 */
export function buildContributionGrid(graphqlData) {
  const weeks = graphqlData?.viewer?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) return [];

  return weeks.map((week) => {
    const days = Array.isArray(week?.contributionDays) ? week.contributionDays : [];
    const cells = days.map((day) =>
      day?.date ? { date: day.date, contributed: !!(day.contributionCount > 0) } : null
    );
    while (cells.length < 7) cells.push(null);
    return cells;
  });
}

/**
 * Is a stored contribution cache stale? True if there's no cache, or its
 * `asOfDateKey` isn't today (UTC) — a rolling window needs a same-day
 * refetch to stay accurate (yesterday's "last day in window" rolls off,
 * today's slot needs to exist). A manual refresh always refetches regardless.
 */
export function isContributionCacheStale(cache, now = new Date()) {
  if (!cache || !cache.asOfDateKey) return true;
  return cache.asOfDateKey !== toDateKeyUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

/**
 * Current streak: consecutive days with >=1 contribution, counted backward
 * from today. Today counts as "pending" (not counted, not breaking) if it
 * has zero contributions so far — the streak only breaks once a day
 * actually closes with nothing logged. So: if today has contributions,
 * count it and keep walking backward; if today has none, skip it (don't
 * break on it) and start the backward walk from yesterday instead.
 *
 * Returns { streak, todayPending }. `todayPending` is true when today has
 * zero contributions so far, purely for UI messaging ("today not logged
 * yet") — it does not affect the numeric streak beyond the walk described
 * above.
 */
export function calculateCurrentStreak(dayMap, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayKey = toDateKeyUTC(today);
  const todayCount = dayMap[todayKey]?.count || 0;
  const todayPending = todayCount === 0;

  let streak = 0;
  const cursor = new Date(today);

  if (!todayPending) {
    streak = 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  } else {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  while (true) {
    const key = toDateKeyUTC(cursor);
    const count = dayMap[key]?.count || 0;
    if (count <= 0) break;
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return { streak, todayPending };
}

/**
 * Sums contribution counts for the current calendar year (Jan 1 through
 * today, UTC) out of a flat dayMap. Safe to rely on with the rolling
 * 12-month window specifically: a 12-month lookback from any date always
 * fully covers Jan 1 of the current year through today, so this never
 * silently under-counts due to data falling outside the fetched range.
 */
export function calculateYearTotal(dayMap, now = new Date()) {
  const yearPrefix = `${now.getUTCFullYear()}-`;
  let total = 0;
  for (const [dateKey, entry] of Object.entries(dayMap || {})) {
    if (dateKey.startsWith(yearPrefix)) {
      total += entry?.count || 0;
    }
  }
  return total;
}