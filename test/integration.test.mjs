// test/integration.test.mjs
// Simulates the real user flow: build a Tier 1 pack for a real repo, track it
// as a project, push it, then re-build and diff against the pushed version —
// without touching chrome APIs at all (mock storage adapter).
//
// Run with: node test/integration.test.mjs

import assert from "node:assert/strict";
import { buildTier1 } from "../lib/build.js";
import { createProjectStore } from "../lib/projectStore.js";
import { diffMarkdown } from "../lib/diff.js";

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

console.log("Building Tier 1 pack for sindresorhus/is-npm...");
const build1 = await buildTier1("sindresorhus/is-npm", null, () => {});
assert.ok(build1.markdown.includes("# Repo: sindresorhus/is-npm"));
assert.ok(build1.tokenEstimate > 0);
console.log(`  ok  - build produced ${build1.tokenEstimate} tokens`);

const projectStore = createProjectStore(makeMockAdapter());
await projectStore.create("is-npm", "is-npm test project", "sindresorhus/is-npm");
console.log("  ok  - project created");

const projectBefore = await projectStore.get("is-npm");
assert.equal(projectBefore.lastPushedMarkdown, null);

// First "push" — simulates clicking Copy/Download/Auto-upload for the first time.
const firstDiff = diffMarkdown(projectBefore.lastPushedMarkdown, build1.markdown);
assert.equal(firstDiff.isFirstPush, true);
console.log(`  ok  - first diff correctly identified as first push (${firstDiff.summary})`);

await projectStore.recordPush("is-npm", {
  markdown: build1.markdown,
  tokens: build1.tokenEstimate,
  changeSummary: firstDiff.summary,
});
console.log("  ok  - first push recorded");

// Simulate a second "Check for Updates" WITHOUT a second live API call — GitHub's
// unauthenticated rate limit is shared across this sandbox, so re-fetching the
// same unchanged repo here would just burn quota to re-prove what module2.test.mjs
// already proves directly. Re-using build1.markdown as a stand-in for "the repo
// hasn't changed" is valid: it's byte-identical to what a real re-fetch would return.
console.log("\nSimulating an unchanged re-fetch (repo state hasn't moved)...");
const projectAfterFirstPush = await projectStore.get("is-npm");
const secondDiff = diffMarkdown(projectAfterFirstPush.lastPushedMarkdown, build1.markdown);

assert.equal(secondDiff.isFirstPush, false);
assert.equal(secondDiff.summary, "No changes detected");
console.log(`  ok  - second diff correctly reports no changes (repo hasn't changed since last push)`);

// Simulate a manual edit to the stored version to confirm the diff engine
// actually detects real changes too, not just "always says no changes."
const mutated = build1.markdown.replace("Check if your code is running as an npm or yarn script", "MUTATED DESCRIPTION");
const thirdDiff = diffMarkdown(mutated, build1.markdown);
assert.notEqual(thirdDiff.summary, "No changes detected");
console.log(`  ok  - diff engine correctly detects a real change: "${thirdDiff.summary}"`);

const history = (await projectStore.get("is-npm")).history;
assert.equal(history.length, 1);
console.log("  ok  - history contains exactly the one recorded push");

console.log("\nAll integration checks passed.");
