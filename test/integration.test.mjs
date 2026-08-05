import assert from "node:assert/strict";
import { getLatestCommit, parseRepoInput } from "../lib/github.js";
import { createProjectStore } from "../lib/projectStore.js";

function makeMockAdapter() {
  let store = {};
  return {
    async get(keys) {
      const out = {};
      for (const k of keys) out[k] = store[k];
      return out;
    },
    async set(obj) {
      store = { ...store, ...obj };
    },
  };
}

function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj };
}

let mockSha = "sha-AAA";
let mockDate = "2026-06-01T00:00:00Z";
let shouldFail = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/commits?per_page=1")) {
    if (shouldFail) throw new Error("simulated network failure");
    return jsonResponse([{ sha: mockSha, commit: { committer: { date: mockDate } } }]);
  }
  throw new Error(`Unhandled mock URL in integration test: ${u}`);
};

/**
 * Mirrors the REAL checkForUpdates in projectsView.js: lastCheckedAt is
 * stamped BEFORE the network call, not after a successful one. This is
 * deliberate — per the GITSTREAK spec, lastCheckedAt must be stamped
 * "every time you check a repo, regardless of outcome." Stamping it only on
 * success would mean a repo failing checks (rate limit, network blip)
 * silently stops showing as recently checked.
 */
async function checkForUpdates(store, id, repo) {
  const { owner, repo: repoName } = parseRepoInput(repo);
  await store.updateLastChecked(id);
  const latest = await getLatestCommit(owner, repoName, null);
  await store.addCommitHistoryEntry(id, latest);
}

async function run() {
  const store = createProjectStore(makeMockAdapter());

  await store.create("is-npm", "is-npm test project", "sindresorhus/is-npm");
  console.log("  ok  - project created");

  const before = await store.get("is-npm");
  assert.equal(before.lastCheckedAt, null);
  assert.deepEqual(before.commitHistory, []);
  console.log("  ok  - new project starts with no check history");

  await checkForUpdates(store, "is-npm", "sindresorhus/is-npm");
  const afterFirst = await store.get("is-npm");
  assert.ok(afterFirst.lastCheckedAt, "lastCheckedAt must be set after the first check");
  assert.equal(afterFirst.commitHistory.length, 1, "commit history entry #1 must exist immediately after add");
  assert.equal(afterFirst.commitHistory[0].sha, "sha-AAA");
  console.log("  ok  - first-add auto-fetch populates history entry #1");

  const firstCheckedAt = afterFirst.lastCheckedAt;
  await new Promise((r) => setTimeout(r, 5));
  await checkForUpdates(store, "is-npm", "sindresorhus/is-npm");
  const afterSecond = await store.get("is-npm");
  assert.equal(afterSecond.commitHistory.length, 1, "an unchanged commit must NOT add a new history entry");
  assert.notEqual(afterSecond.lastCheckedAt, firstCheckedAt, "lastCheckedAt must still update even when the commit is unchanged");
  console.log("  ok  - unchanged repo: lastCheckedAt always updates, commitHistory stays deduped");

  mockSha = "sha-BBB";
  mockDate = "2026-06-15T00:00:00Z";
  await checkForUpdates(store, "is-npm", "sindresorhus/is-npm");
  const afterThird = await store.get("is-npm");
  assert.equal(afterThird.commitHistory.length, 2, "a real new commit must append a new history entry");
  assert.equal(afterThird.commitHistory[0].sha, "sha-BBB", "newest commit must be first");
  assert.equal(afterThird.lastCommitAt, "2026-06-15T00:00:00Z", "lastCommitAt must be derived from the newest entry");
  console.log("  ok  - a real commit change appends a new history entry, newest first");

  for (let i = 0; i < 6; i++) {
    mockSha = `sha-EXTRA-${i}`;
    mockDate = `2026-07-0${i + 1}T00:00:00Z`;
    await checkForUpdates(store, "is-npm", "sindresorhus/is-npm");
  }
  const final = await store.get("is-npm");
  assert.equal(final.commitHistory.length, 6, "commitHistory must never exceed 6 entries");
  assert.equal(final.commitHistory[0].sha, "sha-EXTRA-5", "newest of the extras must be first");
  assert.ok(!final.commitHistory.some((h) => h.sha === "sha-AAA"), "the original oldest entry must have been evicted");
  console.log("  ok  - FIFO cap at 6 holds under a realistic sequence of checks");

  // --- REGRESSION: lastCheckedAt must be stamped even when the check fails ---
  await store.create("flaky-repo", "Flaky Repo", "org/flaky-repo");
  const beforeFailure = await store.get("flaky-repo");
  assert.equal(beforeFailure.lastCheckedAt, null);

  shouldFail = true;
  await assert.rejects(
    () => checkForUpdates(store, "flaky-repo", "org/flaky-repo"),
    /simulated network failure/,
    "a network failure during the check must still propagate to the caller"
  );
  shouldFail = false;

  const afterFailure = await store.get("flaky-repo");
  assert.ok(
    afterFailure.lastCheckedAt,
    "REGRESSION CHECK: lastCheckedAt must be stamped even though the GitHub call failed — per spec, 'stamped every time you check a repo, regardless of outcome'"
  );
  assert.deepEqual(
    afterFailure.commitHistory,
    [],
    "a failed check must never touch commitHistory — only lastCheckedAt changes on failure"
  );
  console.log("  ok  - REGRESSION: lastCheckedAt is stamped even when the GitHub call fails, commitHistory untouched");

  console.log("\nAll integration checks passed.");
}

run()
  .catch((e) => {
    console.error("FAIL -", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
