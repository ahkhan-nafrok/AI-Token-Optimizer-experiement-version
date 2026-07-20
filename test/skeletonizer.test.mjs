// test/skeletonizer.test.mjs
// Run with: node test/skeletonizer.test.mjs
// Pure logic tests for lib/skeletonizer.js — no network, no chrome APIs.

import assert from "node:assert/strict";
import {
  filterTree,
  condenseReadme,
  classifyEntryFiles,
  planContentFetches,
} from "../lib/skeletonizer.js";

let passed = 0;
let failed = 0;
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

// ---------- filterTree: ignore-pattern coverage ----------

test("filterTree: strips node_modules (baseline sanity)", () => {
  const tree = [{ type: "blob", path: "node_modules/foo/index.js", size: 10 }];
  const { kept, trimmed } = filterTree(tree);
  assert.equal(kept.length, 0);
  assert.equal(trimmed.dirs, 1);
});

test("filterTree: strips .venv/ (dotted venv, common Python convention)", () => {
  const tree = [
    { type: "blob", path: ".venv/lib/python3.11/site-packages/pip/__init__.py", size: 10 },
    { type: "blob", path: "src/app.py", size: 10 },
  ];
  const { kept, trimmed } = filterTree(tree);
  assert.equal(kept.length, 1, "only src/app.py should survive — .venv should be fully trimmed");
  assert.equal(kept[0].path, "src/app.py");
  assert.ok(trimmed.dirs >= 1);
});

test("filterTree: strips Rust/Java build output (target/)", () => {
  const tree = [
    { type: "blob", path: "target/debug/build/foo.rlib", size: 10 },
    { type: "blob", path: "src/main.rs", size: 10 },
  ];
  const { kept } = filterTree(tree);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].path, "src/main.rs");
});

test("filterTree: strips Next.js export output (out/)", () => {
  const tree = [
    { type: "blob", path: "out/index.html", size: 10 },
    { type: "blob", path: "pages/index.js", size: 10 },
  ];
  const { kept } = filterTree(tree);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].path, "pages/index.js");
});

// ---------- condenseReadme: badge stripping ----------

test("condenseReadme: strips a multi-badge line (badges chained on one line)", () => {
  const raw = `# My Project\n\n[![Build](https://img.shields.io/a.svg)](https://ci.example.com) [![Coverage](https://img.shields.io/b.svg)](https://cov.example.com) [![License](https://img.shields.io/c.svg)](https://license.example.com)\n\nReal description text here.`;
  const out = condenseReadme(raw);
  assert.ok(!out.includes("img.shields.io"), `badge URLs should be stripped, got: ${out}`);
  assert.ok(out.includes("Real description text here."));
});

// ---------- condenseReadme: truncation boundary ----------

test("condenseReadme: truncation never cuts inside a code fence", () => {
  // Build a README where a ``` fence opens right around the 2000-char cap.
  const filler = "x".repeat(1950);
  const raw = `# Title\n\n${filler}\n\n\`\`\`js\nconst thisShouldNotLeakUnclosed = true;\nconsole.log("still inside the fence");\n\`\`\`\n\nAfter-fence text.`;
  const out = condenseReadme(raw);
  const fenceCount = (out.match(/```/g) || []).length;
  assert.equal(fenceCount % 2, 0, `unbalanced code fences after truncation (found ${fenceCount} backtick-triples) — output: ${out.slice(-200)}`);
});

// ---------- classifyEntryFiles: dropped-fetch transparency ----------

test("classifyEntryFiles: a failed fetch (null content) is reported, not silently dropped", () => {
  const candidates = ["src/main.js"];
  const contentByPath = { "src/main.js": null }; // simulates a failed getFileContent
  const result = classifyEntryFiles(candidates, [], contentByPath);
  const total = result.included.length + result.skeletonized.length + (result.failed || []).length;
  assert.equal(total, 1, "the candidate must show up somewhere in the result — included, skeletonized, or failed");
  assert.ok(result.failed && result.failed.length === 1, "failed fetches should be surfaced in a `failed` array, not just dropped");
});

// ============================================================
// PHASE 2 — SHA-based skip-refetch (scalability core)
// ============================================================

test("filterTree: preserves blob sha per file (needed for change detection)", () => {
  const tree = [{ type: "blob", path: "src/main.js", size: 10, sha: "abc123" }];
  const { kept } = filterTree(tree);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sha, "abc123", "sha must survive filterTree — it's the whole basis for skip-refetch");
});

test("planContentFetches: reuses cached content when tree sha matches cache sha", () => {
  const paths = ["src/main.js"];
  const keptByPath = { "src/main.js": { sha: "same-sha" } };
  const cache = { "src/main.js": { sha: "same-sha", content: "console.log(1)" } };
  const { toFetch, reused } = planContentFetches(paths, keptByPath, cache);
  assert.deepEqual(toFetch, []);
  assert.equal(reused.length, 1);
  assert.equal(reused[0].content, "console.log(1)");
});

test("planContentFetches: refetches when tree sha differs from cached sha", () => {
  const paths = ["src/main.js"];
  const keptByPath = { "src/main.js": { sha: "new-sha" } };
  const cache = { "src/main.js": { sha: "old-sha", content: "stale" } };
  const { toFetch, reused } = planContentFetches(paths, keptByPath, cache);
  assert.deepEqual(toFetch, ["src/main.js"]);
  assert.equal(reused.length, 0);
});

test("planContentFetches: refetches when there is no cache entry at all", () => {
  const paths = ["src/main.js"];
  const keptByPath = { "src/main.js": { sha: "any-sha" } };
  const { toFetch, reused } = planContentFetches(paths, keptByPath, {});
  assert.deepEqual(toFetch, ["src/main.js"]);
  assert.equal(reused.length, 0);
});

test("planContentFetches: refetches when tree has no sha for the path (defensive — never trust a missing sha as a match)", () => {
  const paths = ["src/main.js"];
  const keptByPath = { "src/main.js": { sha: null } };
  const cache = { "src/main.js": { sha: null, content: "should not be trusted" } };
  const { toFetch, reused } = planContentFetches(paths, keptByPath, cache);
  assert.deepEqual(toFetch, ["src/main.js"], "a null/missing sha must never be treated as a valid match, even if both sides are null");
});

test("planContentFetches: a path missing from the tree entirely still gets queued to fetch, not silently dropped", () => {
  const paths = ["src/deleted-file.js"];
  const keptByPath = {}; // path no longer in the tree
  const { toFetch, reused } = planContentFetches(paths, keptByPath, {});
  assert.deepEqual(toFetch, ["src/deleted-file.js"]);
  assert.equal(reused.length, 0);
});

test("planContentFetches: handles a mix of reused and to-fetch paths correctly", () => {
  const paths = ["a.js", "b.js", "c.js"];
  const keptByPath = {
    "a.js": { sha: "sha-a" },
    "b.js": { sha: "sha-b-NEW" },
    "c.js": { sha: "sha-c" },
  };
  const cache = {
    "a.js": { sha: "sha-a", content: "A" },
    "b.js": { sha: "sha-b-OLD", content: "B-old" },
    // c.js has no cache entry at all
  };
  const { toFetch, reused } = planContentFetches(paths, keptByPath, cache);
  assert.deepEqual(toFetch.sort(), ["b.js", "c.js"]);
  assert.deepEqual(reused.map((r) => r.path), ["a.js"]);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;

