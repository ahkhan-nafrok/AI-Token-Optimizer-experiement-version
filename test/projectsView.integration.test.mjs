// test/projectsView.integration.test.mjs
// Runs the REAL projectsView.js against a fake DOM + fake chrome.storage +
// mocked GitHub fetch (commits endpoint, GraphQL endpoint, and /user/repos —
// this module still never touches build.js/getTree/getReadme/getFileContent
// at all).
//
// Run with: node test/projectsView.integration.test.mjs

import assert from "node:assert/strict";

// ---------- Fake DOM ----------
function makeFakeElement(id) {
  const listeners = {};
  let _innerHTML = "";
  let _textContent = "";
  const el = {
    id,
    hidden: false,
    disabled: false,
    value: "",
    open: false,
    _children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    async dispatch(type, evt = {}) {
      for (const fn of listeners[type] || []) await fn(evt);
    },
    appendChild(child) {
      el._children.push(child);
    },
    querySelector() {
      return makeFakeElement("stub-child");
    },
    querySelectorAll() {
      return [];
    },
  };
  Object.defineProperty(el, "textContent", {
    get() { return _textContent; },
    set(v) {
      _textContent = String(v);
      _innerHTML = _textContent
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() { return _innerHTML; },
    set(v) {
      _innerHTML = v;
      el._children = [];
    },
  });
  Object.defineProperty(el, "className", {
    get() { return [...el.classList._set].join(" "); },
    set(v) { el.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  return el;
}

const elementIds = [
  "project-list", "new-project-btn", "new-project-name", "new-project-repo", "new-project-form",
  "project-detail", "pd-name", "pd-repo", "pd-last-checked", "pd-last-commit", "pd-pin-btn",
  "pd-refresh-btn", "pd-status", "pd-history",
  // GitHub Overview additions
  "gh-calendar-token-prompt", "gh-calendar-grid", "gh-calendar-status", "gh-calendar-refresh-btn",
  "gh-recent-token-prompt", "gh-recent-list", "gh-recent-status", "gh-recent-refresh-btn",
];

const elements = {};
for (const id of elementIds) elements[id] = makeFakeElement(id);

globalThis.document = {
  getElementById: (id) => {
    if (!elements[id]) throw new Error(`Test harness gap: projectsView.js requested an element id "${id}" the fake DOM doesn't know about — this itself is a signal the real HTML must have that id.`);
    return elements[id];
  },
  createElement: (tag) => makeFakeElement(`created-${tag}`),
};

globalThis.alert = (msg) => { throw new Error(`alert() was called (should not happen in this test): ${msg}`); };
globalThis.confirm = () => true;

globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) { cb(chromeStorageMock); },
      set(obj, cb) { Object.assign(chromeStorageMock, obj); cb(); },
    },
  },
  runtime: { lastError: null },
};
let chromeStorageMock = {};

// ---------- Fake GitHub API — commits, GraphQL, and /user/repos ----------
function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj };
}

// Derived from the REAL current clock, not hardcoded — so this test stays
// correct whenever it's run, instead of silently breaking after a month
// boundary passes.
const now = new Date();
const curYear = now.getUTCFullYear();
const curMonth = now.getUTCMonth(); // 0-indexed
const curMonthKey = `${curYear}-${String(curMonth + 1).padStart(2, "0")}`;
const curMonthDay1 = `${curYear}-${String(curMonth + 1).padStart(2, "0")}-01`;
const curMonthDay2 = `${curYear}-${String(curMonth + 1).padStart(2, "0")}-02`;
const prevMonthDate = new Date(Date.UTC(curYear, curMonth - 1, 15));
const prevMonthKey = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;

let commitCallCount = 0;
let mockSha = "sha-initial";
let mockDate = "2026-07-01T00:00:00Z";
let graphqlCallCount = 0;
let recentReposCallCount = 0;
let mockRecentRepos = [
  { name: "aixrobo-web", full_name: "ahkhan-nafrok/aixrobo-web", created_at: "2025-01-01T00:00:00Z", pushed_at: "2026-07-20T00:00:00Z" },
  { name: "slatebooks", full_name: "ahkhan-nafrok/slatebooks", created_at: "2025-02-01T00:00:00Z", pushed_at: "2026-07-15T00:00:00Z" },
  { name: "aml-motors", full_name: "ahkhan-nafrok/aml-motors", created_at: "2024-01-01T00:00:00Z", pushed_at: "2026-01-01T00:00:00Z" },
];

globalThis.fetch = async (url, options) => {
  const u = String(url);
  if (u.includes("/commits?per_page=1")) {
    commitCallCount++;
    return jsonResponse([{ sha: mockSha, commit: { committer: { date: mockDate } } }]);
  }
  if (u === "https://api.github.com/graphql") {
    graphqlCallCount++;
    return jsonResponse({
      data: {
        viewer: {
          contributionsCollection: {
            contributionCalendar: {
              weeks: [
                { contributionDays: [{ date: curMonthDay1, contributionCount: 3 }, { date: curMonthDay2, contributionCount: 0 }] },
              ],
            },
          },
        },
      },
    });
  }
  if (u.includes("/user/repos")) {
    recentReposCallCount++;
    return jsonResponse(mockRecentRepos);
  }
  throw new Error(`Unhandled mock URL: ${u}`);
};

// ---------- Run the REAL projectsView.js against all of the above ----------
const { initProjectsView } = await import("../projectsView.js");

console.log("=== Scenario 1: no GitHub token set at all ===");
console.log("Initializing projectsView (real init code, fake DOM, no ghToken in storage)...");
initProjectsView();
// Overview loads are fire-and-forget (not awaited by initProjectsView), so give
// their internal awaited storage/fetch calls a tick to settle before asserting.
await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));
console.log("  ok  - initProjectsView() ran without throwing");

assert.equal(elements["gh-calendar-token-prompt"].hidden, false, "no token: calendar token prompt must be shown");
assert.equal(elements["gh-calendar-grid"].hidden, true, "no token: calendar grid must be hidden");
assert.equal(elements["gh-recent-token-prompt"].hidden, false, "no token: recent-repos token prompt must be shown");
assert.equal(elements["gh-recent-list"].hidden, true, "no token: recent-repos list must be hidden");
assert.equal(graphqlCallCount, 0, "no token: GraphQL must never be called at all");
assert.equal(recentReposCallCount, 0, "no token: /user/repos must never be called at all");
console.log("  ok  - with no token, both Overview sections show their prompts and make ZERO GitHub calls");

console.log("\nCreating a project via the real 'new project' handler...");
elements["new-project-name"].value = "Fake Project";
elements["new-project-repo"].value = "fake/repo";
await elements["new-project-btn"].dispatch("click");
console.log("  ok  - project created without throwing");

console.log("\nConfirming the first-add auto-check populated history entry #1 immediately...");
assert.equal(commitCallCount, 1, "creating a project must trigger exactly one commit-fetch call, automatically");
assert.ok(!elements["pd-last-checked"].textContent.includes("never"), "last-checked must no longer read 'never' after the auto-check");
assert.ok(!elements["pd-last-commit"].textContent.includes("unknown"), "last-commit must no longer read 'unknown' after the auto-check");
assert.ok(
  chromeStorageMock.projects["fake-project"].commitHistory.length === 1,
  "history entry #1 must be recorded in storage immediately on add, not waiting for a manual check"
);
console.log(`  ok  - pd-last-checked: "${elements["pd-last-checked"].textContent}"`);
console.log(`  ok  - pd-last-commit: "${elements["pd-last-commit"].textContent}"`);

console.log("\nClicking 'Check for Updates' again with the SAME upstream commit (no-op expected)...");
commitCallCount = 0;
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(commitCallCount, 1, "a manual check must still make exactly one GitHub call");
assert.equal(
  chromeStorageMock.projects["fake-project"].commitHistory.length,
  1,
  "an unchanged commit must not add a duplicate history entry"
);
console.log("  ok  - unchanged commit: lastChecked updates, history stays deduped at 1 entry");

console.log("\nClicking 'Check for Updates' with a NEW upstream commit...");
mockSha = "sha-changed";
mockDate = "2026-07-20T00:00:00Z";
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(
  chromeStorageMock.projects["fake-project"].commitHistory.length,
  2,
  "a real new commit must append a second history entry"
);
assert.equal(chromeStorageMock.projects["fake-project"].commitHistory[0].sha, "sha-changed", "newest commit must be first");
assert.ok(elements["pd-history"].innerHTML.includes("sha-cha"), "the rendered history should reflect the new commit");
console.log("  ok  - new commit correctly appended, newest-first");

console.log("\n--- Pinning ---");
console.log("Pinning the active project via the detail-view pin button...");
await elements["pd-pin-btn"].dispatch("click");
assert.equal(chromeStorageMock.projects["fake-project"].pinned, true, "pin button click must persist pinned=true");
console.log("  ok  - project pinned, persisted to storage");

console.log("\n--- Multi-project list scenario (scalability + sort check) ---");
console.log("Adding a SECOND project (never checked, simulating a failed auto-check) to test list ordering...");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/commits?per_page=1")) throw new Error("simulated GitHub failure for second project's auto-check");
  return originalFetch(url);
};
elements["new-project-name"].value = "Zzz Second Project";
elements["new-project-repo"].value = "fake/repo2";
await elements["new-project-btn"].dispatch("click");
globalThis.fetch = originalFetch;

assert.equal(
  chromeStorageMock.projects["zzz-second-project"] !== undefined,
  true,
  "the project must still be created even though its first auto-check failed"
);
assert.equal(
  chromeStorageMock.projects["zzz-second-project"].commitHistory.length,
  0,
  "a failed auto-check must leave commitHistory empty, not crash the add flow"
);
console.log("  ok  - a failed first-check doesn't block project creation (non-blocking, as specified)");

const listRows = elements["project-list"]._children;
assert.equal(listRows.length, 2, "both tracked projects should render as rows");
console.log(`  ok  - project-list rendered ${listRows.length} rows`);

assert.ok(listRows[0].innerHTML.includes("Fake Project"), `expected the pinned project first, row 0 was: ${listRows[0].innerHTML.slice(0, 160)}`);
assert.ok(listRows[1].innerHTML.includes("Zzz Second Project"), "the unpinned never-checked project should sort after the pinned one");
assert.ok(listRows[1].innerHTML.includes("badge-pending"), "a never-checked project's row must carry the not-checked badge");
console.log("  ok  - pinned project sorts first regardless of name or recency");
console.log("  ok  - unpinned never-checked project shows the not-checked badge");

console.log("\n=== Scenario 2: GitHub token IS present — GitHub Overview features ===");
chromeStorageMock.ghToken = "ghp_faketoken";

console.log("Clicking the calendar refresh button (manual refresh)...");
graphqlCallCount = 0;
await elements["gh-calendar-refresh-btn"].dispatch("click");
assert.equal(graphqlCallCount, 1, "a manual calendar refresh must make exactly one GraphQL call");
assert.equal(elements["gh-calendar-token-prompt"].hidden, true, "with a token present, the calendar token prompt must be hidden");
assert.equal(elements["gh-calendar-grid"].hidden, false, "with a token present, the calendar grid must be shown");
assert.ok(chromeStorageMock.ghContributionCache, "a successful calendar fetch must be cached in storage");
assert.equal(chromeStorageMock.ghContributionCache.dayMap[curMonthDay1].count, 3, "fetched contribution data must be parsed and cached correctly");
assert.equal(chromeStorageMock.ghContributionCache.monthKey, curMonthKey, "the cache must be tagged with the real current month key");
console.log("  ok  - calendar refresh: exactly one GraphQL call, data cached, grid shown");

console.log("Clicking the calendar refresh button AGAIN with an unchanged month (cache should be reused, but a forced click always refetches)...");
graphqlCallCount = 0;
await elements["gh-calendar-refresh-btn"].dispatch("click");
assert.equal(graphqlCallCount, 1, "an explicit refresh click must always refetch, regardless of cache freshness");
console.log("  ok  - explicit refresh always makes a real call, never silently served from cache");

console.log("\nClicking the recently-pushed refresh button (manual refresh)...");
recentReposCallCount = 0;
await elements["gh-recent-refresh-btn"].dispatch("click");
assert.equal(recentReposCallCount, 1, "a manual recent-repos refresh must make exactly one /user/repos call");
assert.equal(elements["gh-recent-token-prompt"].hidden, true, "with a token present, the recent-repos token prompt must be hidden");
assert.equal(elements["gh-recent-list"].hidden, false, "with a token present, the recent-repos list must be shown");
assert.equal(chromeStorageMock.ghRecentRepos.repos.length, 2, "recently-pushed must be capped at 2 entries");
assert.equal(chromeStorageMock.ghRecentRepos.repos[0].name, "aixrobo-web", "the most recently pushed repo must rank first");
assert.ok(elements["gh-recent-list"].innerHTML.includes("aixrobo-web"), "the rendered list must show the top-ranked repo");
console.log("  ok  - recently-pushed refresh: exactly one call, ranked top-2 cached and rendered");

console.log("\n=== Scenario 3: month rollover ===");
console.log("Simulating the popup being reopened in a NEW month with a stale cached calendar (no forced click this time)...");
chromeStorageMock.ghContributionCache = { monthKey: prevMonthKey, dayMap: { "irrelevant-old-day": { count: 1 } }, fetchedAt: prevMonthDate.toISOString() };
graphqlCallCount = 0;
// Re-invoke the non-forced load path the same way initProjectsView does on open.
const { initProjectsView: reinit } = await import("../projectsView.js?scenario3");
reinit();
await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));
assert.equal(graphqlCallCount, 1, "a cache from a PREVIOUS month must trigger an automatic refetch, with no button click needed");
assert.equal(chromeStorageMock.ghContributionCache.monthKey, curMonthKey, "the cache must be updated to the real current month after the automatic refetch");
console.log("  ok  - month rollover auto-refetches the calendar without requiring a manual click");

console.log("\nAll projectsView integration checks passed.");
