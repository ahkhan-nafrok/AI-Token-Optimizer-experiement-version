// test/skeletonizer.contextupgrade.test.mjs
// Covers the reframe additions: monorepo manifest discovery, Tier 2 signature
// extraction, local-import relationship extraction, and the pre-fetch size
// guard (never download a huge file just to discard it after the fact).
// Run with: node test/skeletonizer.contextupgrade.test.mjs

import assert from "node:assert/strict";
import {
  findManifestFiles,
  findManifestFile,
  assembleManifestSection,
  summarizeManifest,
  detectEntryFileCandidates,
  shouldSkipFetchForSize,
  extractSignatures,
  extractImports,
  classifyEntryFiles,
  ENTRY_SIZE_PREFETCH_GUARD_BYTES,
  ENTRY_SIZE_CAP_LINES,
} from "../lib/skeletonizer.js";

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

// ---------- Monorepo manifest discovery ----------

test("findManifestFiles: discovers multiple package.json files in a monorepo, root first", () => {
  const paths = new Set(["package.json", "packages/api/package.json", "packages/web/package.json", "README.md"]);
  const found = findManifestFiles(paths);
  assert.equal(found.length, 3);
  assert.equal(found[0].path, "package.json", "root manifest must sort first (shallowest depth)");
});

test("findManifestFile (back-compat): still returns just the root-most manifest as a single object", () => {
  const paths = new Set(["packages/api/package.json", "package.json"]);
  const m = findManifestFile(paths);
  assert.equal(m.path, "package.json");
});

test("findManifestFiles: single-manifest repo behaves identically to before (one result)", () => {
  const paths = new Set(["package.json", "index.js"]);
  const found = findManifestFiles(paths);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "package.json");
});

test("assembleManifestSection: single manifest produces the old plain-text format (no monorepo header)", () => {
  const summary = summarizeManifest({ lang: "node", path: "package.json" }, JSON.stringify({ name: "x", version: "1.0.0" }));
  const section = assembleManifestSection([{ ...summary, path: "package.json" }]);
  assert.ok(!section.includes("Monorepo"), "single-manifest output must not mention monorepo at all");
  assert.ok(section.includes("**x**"));
});

test("assembleManifestSection: multiple manifests produce a labeled, grouped monorepo section", () => {
  const s1 = { ...summarizeManifest({ lang: "node", path: "package.json" }, JSON.stringify({ name: "root" })), path: "package.json" };
  const s2 = { ...summarizeManifest({ lang: "node", path: "packages/api/package.json" }, JSON.stringify({ name: "api" })), path: "packages/api/package.json" };
  const section = assembleManifestSection([s1, s2]);
  assert.ok(section.includes("Monorepo detected — 2 manifests found"));
  assert.ok(section.includes("### package.json"));
  assert.ok(section.includes("### packages/api/package.json"));
});

test("detectEntryFileCandidates: resolves a manifest's main entry relative to ITS OWN directory, not always the repo root", () => {
  const paths = new Set(["packages/api/package.json", "packages/api/index.js", "package.json"]);
  const summaries = [
    { dir: "packages/api", mainEntry: "index.js", startScript: null },
  ];
  const candidates = detectEntryFileCandidates(paths, summaries);
  assert.ok(candidates.includes("packages/api/index.js"), `expected packages/api/index.js in candidates, got: ${candidates.join(", ")}`);
});

test("detectEntryFileCandidates: root manifest (empty dir) behaves exactly as before", () => {
  const paths = new Set(["index.js"]);
  const summaries = [{ dir: "", mainEntry: "index.js", startScript: null }];
  const candidates = detectEntryFileCandidates(paths, summaries);
  assert.deepEqual(candidates, ["index.js"]);
});

// ---------- Pre-fetch size guard ----------

test("shouldSkipFetchForSize: flags a file over the byte guard for skipping, using tree size only (no fetch needed to know)", () => {
  const keptByPath = { "big.js": { size: ENTRY_SIZE_PREFETCH_GUARD_BYTES + 1 } };
  assert.equal(shouldSkipFetchForSize("big.js", keptByPath), true);
});

test("shouldSkipFetchForSize: does not flag a normal-sized file", () => {
  const keptByPath = { "small.js": { size: 500 } };
  assert.equal(shouldSkipFetchForSize("small.js", keptByPath), false);
});

test("shouldSkipFetchForSize: missing size info falls through to false (never guess, fetch as before)", () => {
  const keptByPath = { "unknown.js": {} };
  assert.equal(shouldSkipFetchForSize("unknown.js", keptByPath), false);
});

test("classifyEntryFiles: a size-guard-skipped path (never fetched) is classified as skeletonized with an estimated line count, not 'failed'", () => {
  const candidates = ["huge.js"];
  const contentByPath = {}; // never fetched at all — no key present
  const keptByPath = { "huge.js": { size: 40000 } };
  const result = classifyEntryFiles(candidates, [], contentByPath, keptByPath);
  assert.equal(result.failed.length, 0, "a size-guard skip is a deliberate decision, not a failure");
  assert.equal(result.skeletonized.length, 1);
  assert.equal(result.skeletonized[0].skippedFetch, true);
  assert.ok(result.skeletonized[0].estimatedLineCount > 0);
});

test("classifyEntryFiles: a path missing from contentByPath with no oversized tree entry is still reported as failed (not silently dropped)", () => {
  const candidates = ["gone.js"];
  const result = classifyEntryFiles(candidates, [], {}, {});
  assert.equal(result.failed.length, 1);
  assert.equal(result.skeletonized.length, 0);
});

// ---------- Tier 2 signature extraction ----------

test("extractSignatures: pulls function/class/export signatures out of a JS file", () => {
  const content = [
    "import x from './x.js';",
    "export function handleRequest(req, res) {",
    "  return doWork(req);",
    "}",
    "",
    "class Server {",
    "  start() {}",
    "}",
    "",
    "export const util = () => {};",
  ].join("\n");
  const sigs = extractSignatures(content, "server.js");
  const texts = sigs.map((s) => s.signature);
  assert.ok(texts.some((t) => t.includes("export function handleRequest")), `got: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes("class Server")));
  assert.ok(texts.some((t) => t.includes("export const util")));
});

test("extractSignatures: pulls def/class signatures out of a Python file", () => {
  const content = ["import os", "", "def main():", "    pass", "", "class Handler:", "    def run(self):", "        pass"].join("\n");
  const sigs = extractSignatures(content, "main.py");
  const texts = sigs.map((s) => s.signature);
  assert.ok(texts.some((t) => t.includes("def main()")));
  assert.ok(texts.some((t) => t.includes("class Handler")));
});

test("extractSignatures: unrecognized language returns an empty list, not a crash", () => {
  const sigs = extractSignatures("some random content", "notes.txt");
  assert.deepEqual(sigs, []);
});

test("classifyEntryFiles: an over-cap JS file gets real signatures attached, not just a line count", () => {
  const bigContent = Array.from({ length: ENTRY_SIZE_CAP_LINES + 10 }, (_, i) => `// line ${i}`).join("\n") +
    "\nexport function realFunction() {}\n";
  const candidates = ["big.js"];
  const contentByPath = { "big.js": bigContent };
  const result = classifyEntryFiles(candidates, [], contentByPath, {});
  assert.equal(result.skeletonized.length, 1);
  assert.ok(result.skeletonized[0].signatures.some((s) => s.signature.includes("realFunction")));
});

// ---------- Relationship / import extraction ----------

test("extractImports: surfaces LOCAL relative imports only, ignores external packages (already covered by Dependencies)", () => {
  const content = [
    "import React from 'react';",
    "import { helper } from './utils/helper.js';",
    "import Config from '../config';",
  ].join("\n");
  const imports = extractImports(content, "src/app.js");
  assert.ok(!imports.includes("react"), "external package imports should be filtered out");
  assert.ok(imports.includes("./utils/helper.js"));
  assert.ok(imports.includes("../config"));
});

test("extractImports: Python relative imports are surfaced", () => {
  const content = "from .models import User\nfrom . import views\nimport os\n";
  const imports = extractImports(content, "app/main.py");
  assert.ok(imports.includes(".models"));
});

test("extractImports: unrecognized language returns empty array", () => {
  assert.deepEqual(extractImports("whatever", "readme.md"), []);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
