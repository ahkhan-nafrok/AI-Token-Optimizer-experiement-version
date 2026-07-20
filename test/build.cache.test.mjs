// test/build.cache.test.mjs
// Deterministic test of the SHA-skip cache using a mocked GitHub API — no live
// network, no rate-limit flakiness. This is intentional: a test suite that
// depends on a shared-IP rate limit is exactly the kind of fragile dependency
// this project's own SETUP_GUIDE warns about, so the cache logic (the part
// that actually matters) is verified against a fake but fully controlled repo.
//
// Run with: node test/build.cache.test.mjs

import assert from "node:assert/strict";
import { buildTier1 } from "../lib/build.js";

function b64(s) {
  return Buffer.from(s, "utf-8").toString("base64");
}

const PKG_JSON = JSON.stringify({ name: "fake-pkg", version: "1.0.0", main: "index.js" });
const INDEX_JS_V1 = "console.log('v1');";
const INDEX_JS_V2 = "console.log('v2 — this file changed');";

function makeTree({ indexSha }) {
  return [
    { type: "blob", path: "package.json", size: PKG_JSON.length, sha: "sha-pkg-CONSTANT" },
    { type: "blob", path: "index.js", size: 50, sha: indexSha },
  ];
}

function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => obj,
  };
}

function makeMockFetch({ indexSha, indexContent }) {
  const callCounts = { "package.json": 0, "index.js": 0, tree: 0, readme: 0, meta: 0 };

  const fetchFn = async (url) => {
    const u = String(url);

    if (/\/repos\/[^/]+\/[^/]+$/.test(u) && !u.includes("/git/") && !u.includes("/readme") && !u.includes("/contents/")) {
      callCounts.meta++;
      return jsonResponse({ default_branch: "main", description: "Fake repo", language: "JavaScript" });
    }
    if (u.includes("/git/trees/")) {
      callCounts.tree++;
      return jsonResponse({ tree: makeTree({ indexSha }), truncated: false });
    }
    if (u.includes("/readme")) {
      callCounts.readme++;
      return jsonResponse({ content: b64("# Fake\n\nA fake readme."), encoding: "base64" });
    }
    if (u.includes("/contents/package.json")) {
      callCounts["package.json"]++;
      return jsonResponse({ content: b64(PKG_JSON), encoding: "base64" });
    }
    if (u.includes("/contents/index.js")) {
      callCounts["index.js"]++;
      return jsonResponse({ content: b64(indexContent), encoding: "base64" });
    }
    throw new Error(`Unhandled mock URL: ${u}`);
  };

  return { fetchFn, callCounts };
}

const originalFetch = globalThis.fetch;

async function run() {
  const mock1 = makeMockFetch({ indexSha: "sha-index-V1", indexContent: INDEX_JS_V1 });
  globalThis.fetch = mock1.fetchFn;
  const build1 = await buildTier1("fake/repo", null, () => {});

  assert.equal(mock1.callCounts["package.json"], 1, "cold build must fetch the manifest once");
  assert.equal(mock1.callCounts["index.js"], 1, "cold build must fetch the entry file once");
  assert.equal(build1.cacheStats.reused, 0, "cold build has no cache, nothing should be reused");
  assert.ok(build1.markdown.includes("console.log('v1')"), "v1 content should appear in the output");
  console.log("  ok  - cold build fetches manifest + entry file exactly once each, reused=0");

  const mock2 = makeMockFetch({ indexSha: "sha-index-V1", indexContent: INDEX_JS_V1 });
  globalThis.fetch = mock2.fetchFn;
  const build2 = await buildTier1("fake/repo", null, () => {}, build1.fileCache);

  assert.equal(mock2.callCounts["package.json"], 0, "unchanged manifest must NOT be refetched when sha matches cache");
  assert.equal(mock2.callCounts["index.js"], 0, "unchanged entry file must NOT be refetched when sha matches cache");
  assert.equal(build2.cacheStats.reused, 2, "both manifest and entry file should be reported as reused");
  assert.equal(build2.markdown, build1.markdown, "reused content must produce byte-identical output to a fresh fetch of the same content");
  console.log("  ok  - warm build with unchanged repo makes ZERO content-fetch calls, output is byte-identical");

  const mock3 = makeMockFetch({ indexSha: "sha-index-V2-CHANGED", indexContent: INDEX_JS_V2 });
  globalThis.fetch = mock3.fetchFn;
  const build3 = await buildTier1("fake/repo", null, () => {}, build1.fileCache);

  assert.equal(mock3.callCounts["package.json"], 0, "manifest is unchanged (same sha) — must still be skipped");
  assert.equal(mock3.callCounts["index.js"], 1, "changed entry file must be refetched exactly once");
  assert.equal(build3.cacheStats.reused, 1, "only the manifest should be reused; the changed file should not be");
  assert.ok(build3.markdown.includes("v2 — this file changed"), "new content must appear in output");
  assert.ok(!build3.markdown.includes("console.log('v1')"), "old content must NOT leak into output after a real change");
  console.log("  ok  - changed file triggers exactly one refetch, unchanged manifest is still skipped, no stale content leaks");

  const corruptedCache = {
    "package.json": { sha: "totally-wrong-sha", content: "STALE FAKE CONTENT" },
    "index.js": { sha: "also-wrong", content: "STALE FAKE CONTENT" },
  };
  const mock4 = makeMockFetch({ indexSha: "sha-index-V1", indexContent: INDEX_JS_V1 });
  globalThis.fetch = mock4.fetchFn;
  const build4 = await buildTier1("fake/repo", null, () => {}, corruptedCache);

  assert.equal(mock4.callCounts["package.json"], 1, "mismatched sha must force a real refetch of the manifest");
  assert.equal(mock4.callCounts["index.js"], 1, "mismatched sha must force a real refetch of the entry file");
  assert.ok(!build4.markdown.includes("STALE FAKE CONTENT"), "corrupted cache content must never leak into output");
  assert.equal(build4.markdown, build1.markdown, "after a forced refetch, output must match the real current content");
  console.log("  ok  - a corrupted/mismatched cache is never trusted; real content is always refetched instead");

  console.log("\nAll cache tests passed (4/4).");
}

run()
  .catch((e) => {
    console.error("FAIL -", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
