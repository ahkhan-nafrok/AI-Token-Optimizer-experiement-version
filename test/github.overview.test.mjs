// test/github.overview.test.mjs
// Mocked-network tests for the two NEW functions added to lib/github.js
// (ghGraphQL, getMyRecentRepos) for the GitHub Overview feature. Mocked
// fetch throughout — no live network calls, no rate-limit risk.
// Run with: node test/github.overview.test.mjs

import assert from "node:assert/strict";
import { ghGraphQL, getMyRecentRepos } from "../lib/github.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.message}`);
  }
}

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, statusText: ok ? "OK" : "Error", headers: { get: () => null }, json: async () => obj };
}

const originalFetch = globalThis.fetch;

// ---------- ghGraphQL ----------

await test("ghGraphQL: throws immediately (no network call) when no token is provided", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(() => ghGraphQL("query {}", {}, null), /GitHub token/);
  assert.equal(called, false, "a missing token must fail fast, without ever hitting the network");
});

await test("ghGraphQL: POSTs to /graphql with the query, variables, and Authorization header", async () => {
  let capturedUrl, capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return jsonResponse({ data: { viewer: { login: "ahkhan-nafrok" } } });
  };
  const data = await ghGraphQL("query { viewer { login } }", { from: "a", to: "b" }, "ghp_faketoken");
  assert.equal(capturedUrl, "https://api.github.com/graphql");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers.Authorization, "Bearer ghp_faketoken");
  const sentBody = JSON.parse(capturedOptions.body);
  assert.equal(sentBody.query, "query { viewer { login } }");
  assert.deepEqual(sentBody.variables, { from: "a", to: "b" });
  assert.equal(data.viewer.login, "ahkhan-nafrok");
});

await test("ghGraphQL: throws a clear error on a GraphQL-level error array (even with HTTP 200)", async () => {
  globalThis.fetch = async () => jsonResponse({ errors: [{ message: "Could not resolve to a User" }] });
  await assert.rejects(() => ghGraphQL("query {}", {}, "tok"), /Could not resolve to a User/);
});

await test("ghGraphQL: throws on a non-OK HTTP status", async () => {
  globalThis.fetch = async () => jsonResponse({}, false, 401);
  await assert.rejects(() => ghGraphQL("query {}", {}, "bad-token"), /401/);
});

// ---------- getMyRecentRepos ----------

await test("getMyRecentRepos: throws immediately (no network call) when no token is provided", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse([]); };
  await assert.rejects(() => getMyRecentRepos(null), /GitHub token/);
  assert.equal(called, false);
});

await test("getMyRecentRepos: calls /user/repos?sort=pushed with the given sample size and returns the array", async () => {
  let capturedUrl;
  const fakeRepos = [{ name: "a", full_name: "me/a" }, { name: "b", full_name: "me/b" }];
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse(fakeRepos);
  };
  const repos = await getMyRecentRepos("ghp_faketoken", 5);
  assert.ok(capturedUrl.includes("/user/repos"), `expected /user/repos in URL, got: ${capturedUrl}`);
  assert.ok(capturedUrl.includes("sort=pushed"));
  assert.ok(capturedUrl.includes("per_page=5"));
  assert.deepEqual(repos, fakeRepos);
});

await test("getMyRecentRepos: defaults to a sample size of 20 when not specified", async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = String(url); return jsonResponse([]); };
  await getMyRecentRepos("ghp_faketoken");
  assert.ok(capturedUrl.includes("per_page=20"));
});

await test("getMyRecentRepos: a non-array response degrades to an empty array rather than crashing", async () => {
  globalThis.fetch = async () => jsonResponse({ message: "not an array, e.g. a rate-limit body" });
  const repos = await getMyRecentRepos("ghp_faketoken");
  assert.deepEqual(repos, []);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
globalThis.fetch = originalFetch;
