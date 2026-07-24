// test/projectsView.integration.test.mjs
// Runs the REAL projectsView.js against a fake DOM + fake chrome.storage +
// mocked GitHub fetch (commits endpoint only — this module no longer touches
// build.js/getTree/getReadme/getFileContent at all).
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

// ---------- Fake GitHub API — commits endpoint only ----------
function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj };
}

let commitCallCount = 0;
let mockSha = "sha-initial";
let mockDate = "2026-07-01T00:00:00Z";
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/commits?per_page=1")) {
    commitCallCount++;
    return jsonResponse([{ sha: mockSha, commit: { committer: { date: mockDate } } }]);
  }
  throw new Error(`Unhandled mock URL: ${u}`);
};

// ---------- Run the REAL projectsView.js against all of the above ----------
const { initProjectsView } = await import("../projectsView.js");

console.log("Initializing projectsView (real init code, fake DOM)...");
initProjectsView();
console.log("  ok  - initProjectsView() ran without throwing");

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
// Make the auto-check fail for the second project so it stays never-checked,
// exercising the non-blocking "project still created" path.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  throw new Error("simulated GitHub failure for second project's auto-check");
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

// Row order: "Fake Project" is pinned and must sort first regardless of its
// alphabetically-later name and regardless of the second project being
// never-checked — pinning always wins over commit-recency ordering.
assert.ok(listRows[0].innerHTML.includes("Fake Project"), `expected the pinned project first, row 0 was: ${listRows[0].innerHTML.slice(0, 160)}`);
assert.ok(listRows[1].innerHTML.includes("Zzz Second Project"), "the unpinned never-checked project should sort after the pinned one");
assert.ok(listRows[1].innerHTML.includes("badge-pending"), "a never-checked project's row must carry the not-checked badge");
console.log("  ok  - pinned project sorts first regardless of name or recency");
console.log("  ok  - unpinned never-checked project shows the not-checked badge");

console.log("\nAll projectsView integration checks passed.");

