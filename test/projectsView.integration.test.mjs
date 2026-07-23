// test/projectsView.integration.test.mjs
// Runs the REAL projectsView.js against a fake DOM + fake chrome.storage +
// mocked GitHub fetch. Updated for the reframe: pinning, GitHub-commit-recency
// sorting (via meta.pushed_at, piggybacked on the existing repo-meta call —
// no extra network call), and the new pd-pin-btn / pd-last-commit elements.
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
  "project-detail", "pd-name", "pd-repo", "pd-push-status", "pd-last-commit", "pd-pin-btn",
  "pd-refresh-btn", "pd-status", "pd-diff",
  "pd-diff-summary", "pd-capacity-warning", "pd-copy-btn", "pd-download-btn",
  "pd-autoupload-btn", "pd-push-result", "pd-history",
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

if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", { value: {}, writable: true, configurable: true });
}
globalThis.navigator.clipboard = { writeText: async () => {} };

globalThis.alert = (msg) => { throw new Error(`alert() was called (should not happen in this test): ${msg}`); };
globalThis.confirm = () => true;

let downloadCalls = 0;
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) { cb(chromeStorageMock); },
      set(obj, cb) { Object.assign(chromeStorageMock, obj); cb(); },
    },
  },
  downloads: {
    download: (opts, cb) => { downloadCalls++; cb(); },
  },
  tabs: {
    query: async () => [],
  },
  runtime: { lastError: null },
};
let chromeStorageMock = {};

globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };

// ---------- Fake GitHub API ----------
function b64(s) { return Buffer.from(s, "utf-8").toString("base64"); }
const PKG_JSON = JSON.stringify({ name: "fake-pkg", version: "1.0.0", main: "index.js" });
const INDEX_JS = "console.log('hello');";
const FAKE_PUSHED_AT = "2026-07-15T12:00:00Z"; // simulated "last commit on GitHub" timestamp

function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj };
}

let fetchCallCounts = { "package.json": 0, "index.js": 0 };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/\/repos\/[^/]+\/[^/]+$/.test(u) && !u.includes("/git/") && !u.includes("/readme") && !u.includes("/contents/")) {
    return jsonResponse({ default_branch: "main", description: "Fake", language: "JavaScript", pushed_at: FAKE_PUSHED_AT });
  }
  if (u.includes("/git/trees/")) {
    return jsonResponse({
      tree: [
        { type: "blob", path: "package.json", size: PKG_JSON.length, sha: "sha-pkg-1" },
        { type: "blob", path: "index.js", size: 20, sha: "sha-index-1" },
      ],
    });
  }
  if (u.includes("/readme")) return jsonResponse({ content: b64("# Fake\n"), encoding: "base64" });
  if (u.includes("/contents/package.json")) {
    fetchCallCounts["package.json"]++;
    return jsonResponse({ content: b64(PKG_JSON), encoding: "base64" });
  }
  if (u.includes("/contents/index.js")) {
    fetchCallCounts["index.js"]++;
    return jsonResponse({ content: b64(INDEX_JS), encoding: "base64" });
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

console.log("\nChecking pd-push-status pill shows 'pending' immediately on open, before any refresh...");
assert.ok(elements["pd-push-status"].classList.contains("pending"), "a never-pushed project must show the pending pill on open");
assert.ok(elements["pd-push-status"].textContent.includes("Not yet pushed"), `got: ${elements["pd-push-status"].textContent}`);
assert.ok(elements["pd-last-commit"].textContent.includes("unknown"), "before any check, last-commit must read as unknown, not guessed");
console.log(`  ok  - pd-push-status: "${elements["pd-push-status"].textContent}"`);
console.log(`  ok  - pd-last-commit: "${elements["pd-last-commit"].textContent}"`);

console.log("\nFirst 'Check for Updates' click (cold cache)...");
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(fetchCallCounts["package.json"], 1, "cold refresh should fetch the manifest once");
assert.equal(fetchCallCounts["index.js"], 1, "cold refresh should fetch the entry file once");
assert.ok(elements["pd-diff-summary"].textContent.includes("No version pushed yet"), `expected instructive first-push copy, got: ${elements["pd-diff-summary"].textContent}`);
assert.ok(elements["pd-diff"].classList.contains("needs-baseline"), "the diff box must carry needs-baseline so CSS can emphasize the push buttons");
console.log(`  ok  - pd-diff-summary: "${elements["pd-diff-summary"].textContent}"`);

console.log("\nConfirming the commit-recency signal was captured on check WITHOUT requiring a push (piggybacked on the repo-meta call, zero extra network calls)...");
assert.ok(!elements["pd-last-commit"].textContent.includes("unknown"), "after a check, last-commit must no longer read as unknown");
assert.ok(chromeStorageMock.projects["fake-project"].lastCommitAt, "lastCommitAt must be recorded in storage immediately on check, independent of pushing");
console.log(`  ok  - pd-last-commit updated: "${elements["pd-last-commit"].textContent}"`);

console.log("\nClicking Copy to push it (real confirmPush -> real store.recordPush)...");
await elements["pd-copy-btn"].dispatch("click");
console.log("  ok  - copy/push completed without throwing");
assert.ok(
  Object.keys(chromeStorageMock.projects["fake-project"].fileCache).length === 2,
  "after a push, the project's fileCache in storage should contain both cached files"
);

console.log("\nConfirming pd-push-status flips to 'pushed' after the push...");
assert.ok(elements["pd-push-status"].classList.contains("pushed"), "status pill must flip to pushed after a real push");
assert.ok(!elements["pd-push-status"].classList.contains("pending"), "pending class must be removed once pushed");
assert.ok(!elements["pd-diff"].classList.contains("needs-baseline"), "needs-baseline must clear after re-opening a now-pushed project");
console.log(`  ok  - pd-push-status: "${elements["pd-push-status"].textContent}"`);

console.log("\nSecond 'Check for Updates' click (warm cache — repo unchanged)...");
fetchCallCounts = { "package.json": 0, "index.js": 0 };
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(fetchCallCounts["package.json"], 0, "warm refresh must NOT refetch the unchanged manifest");
assert.equal(fetchCallCounts["index.js"], 0, "warm refresh must NOT refetch the unchanged entry file");
assert.ok(elements["pd-diff-summary"].textContent.includes("No changes detected"), `expected no-changes summary, got: ${elements["pd-diff-summary"].textContent}`);
assert.ok(elements["pd-diff-summary"].textContent.includes("unchanged (skipped)"), "the UI should surface the cache-skip count to the user");
console.log(`  ok  - pd-diff-summary: "${elements["pd-diff-summary"].textContent}"`);

console.log("\n--- Pinning ---");
console.log("Pinning the active project via the detail-view pin button...");
await elements["pd-pin-btn"].dispatch("click");
const storedProject = chromeStorageMock.projects["fake-project"];
assert.equal(storedProject.pinned, true, "pin button click must persist pinned=true");
console.log("  ok  - project pinned, persisted to storage");

console.log("\n--- Multi-project list scenario (scalability + sort check) ---");
console.log("Adding a SECOND project (never checked) to test list ordering through real rendering...");
elements["new-project-name"].value = "Zzz Second Project";
elements["new-project-repo"].value = "fake/repo2";
await elements["new-project-btn"].dispatch("click");

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
console.log("\nNOTE — what this test does NOT verify: pixel-accurate rendering, real click");
console.log("physics, or the auto-upload content-script path (that one talks to a real");
console.log("claude.ai tab via chrome.tabs.sendMessage, which has no meaningful fake here).");
console.log("Those need your eyes in an actual loaded extension, same as before.");
