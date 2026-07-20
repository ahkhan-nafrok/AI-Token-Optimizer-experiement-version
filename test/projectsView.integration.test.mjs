// test/projectsView.integration.test.mjs
// Runs the REAL projectsView.js against a fake DOM + fake chrome.storage +
// mocked GitHub fetch. This is not a full browser, but it exercises every
// line of the actual wiring (event handlers, store calls, buildTier1 calls)
// rather than just checking syntax. Where the fake DOM is too simplistic to
// represent real click/rendering behavior, that's called out at the bottom —
// same honesty policy as the original SETUP_GUIDE's "not click-tested in an
// actual browser" note.
//
// Run with: node test/projectsView.integration.test.mjs

import assert from "node:assert/strict";

// ---------- Fake DOM ----------
function makeFakeElement(id) {
  const listeners = {};
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    value: "",
    open: false,
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
    appendChild() {},
    querySelector() {
      // The only querySelector call in projectsView.js is row.querySelector(".p-delete")
      // right after row.innerHTML is set from a template that always includes that button.
      // Return a stub clickable element so wiring doesn't throw.
      return makeFakeElement("stub-child");
    },
    querySelectorAll() {
      return [];
    },
  };
}

const elementIds = [
  "project-list", "new-project-btn", "new-project-name", "new-project-repo", "new-project-form",
  "project-detail", "pd-name", "pd-repo", "pd-refresh-btn", "pd-status", "pd-diff",
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

// URL.createObjectURL/revokeObjectURL used by the Download button path
globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };

// ---------- Fake GitHub API (same shape as build.cache.test.mjs) ----------
function b64(s) { return Buffer.from(s, "utf-8").toString("base64"); }
const PKG_JSON = JSON.stringify({ name: "fake-pkg", version: "1.0.0", main: "index.js" });
const INDEX_JS = "console.log('hello');";

function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj };
}

let fetchCallCounts = { "package.json": 0, "index.js": 0 };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/\/repos\/[^/]+\/[^/]+$/.test(u) && !u.includes("/git/") && !u.includes("/readme") && !u.includes("/contents/")) {
    return jsonResponse({ default_branch: "main", description: "Fake", language: "JavaScript" });
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

console.log("\nFirst 'Check for Updates' click (cold cache)...");
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(fetchCallCounts["package.json"], 1, "cold refresh should fetch the manifest once");
assert.equal(fetchCallCounts["index.js"], 1, "cold refresh should fetch the entry file once");
assert.ok(elements["pd-diff-summary"].textContent.includes("First push"), `expected first-push summary, got: ${elements["pd-diff-summary"].textContent}`);
console.log(`  ok  - pd-diff-summary: "${elements["pd-diff-summary"].textContent}"`);

console.log("\nClicking Copy to push it (real confirmPush -> real store.recordPush)...");
await elements["pd-copy-btn"].dispatch("click");
console.log("  ok  - copy/push completed without throwing");
console.log(`  ok  - stored fileCache in chrome.storage mock has keys: ${Object.keys(chromeStorageMock.projects["fake-project"].fileCache).join(", ")}`);
assert.ok(
  Object.keys(chromeStorageMock.projects["fake-project"].fileCache).length === 2,
  "after a push, the project's fileCache in storage should contain both cached files"
);

console.log("\nSecond 'Check for Updates' click (warm cache — repo unchanged)...");
fetchCallCounts = { "package.json": 0, "index.js": 0 }; // reset counters to isolate this refresh
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(fetchCallCounts["package.json"], 0, "warm refresh must NOT refetch the unchanged manifest");
assert.equal(fetchCallCounts["index.js"], 0, "warm refresh must NOT refetch the unchanged entry file");
assert.ok(elements["pd-diff-summary"].textContent.includes("No changes detected"), `expected no-changes summary, got: ${elements["pd-diff-summary"].textContent}`);
assert.ok(elements["pd-diff-summary"].textContent.includes("unchanged (skipped)"), "the UI should surface the cache-skip count to the user");
console.log(`  ok  - pd-diff-summary: "${elements["pd-diff-summary"].textContent}"`);
console.log("  ok  - warm refresh through the REAL popup wiring made zero content-fetch calls, exactly as build.cache.test.mjs proved in isolation");

console.log("\nAll projectsView integration checks passed.");
console.log("\nNOTE — what this test does NOT verify: pixel-accurate rendering, real click");
console.log("physics, or the auto-upload content-script path (that one talks to a real");
console.log("claude.ai tab via chrome.tabs.sendMessage, which has no meaningful fake here).");
console.log("Those need your eyes in an actual loaded extension, same as the original SETUP_GUIDE says.");
