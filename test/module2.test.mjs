import assert from "node:assert/strict";
import { parseSections, diffMarkdown } from "../lib/diff.js";
import { createProjectStore, capacityWarning, DEFAULT_TOKEN_CAP } from "../lib/projectStore.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

test("parseSections splits on ## headers", () => {
  const md = `# Title\nintro text\n\n## Structure\nfile tree here\n\n## Dependencies\ndeps here`;
  const sections = parseSections(md);
  assert.equal(sections["Structure"], "file tree here");
  assert.equal(sections["Dependencies"], "deps here");
  assert.ok(sections["_preamble"].includes("intro text"));
});

test("diffMarkdown: first push reports all sections as added", () => {
  const md = `## Structure\na\n\n## Dependencies\nb`;
  const result = diffMarkdown(null, md);
  assert.equal(result.isFirstPush, true);
  assert.deepEqual(result.added.sort(), ["Dependencies", "Structure"]);
});

test("diffMarkdown: identical content reports no changes", () => {
  const md = `## Structure\na\n\n## Dependencies\nb`;
  const result = diffMarkdown(md, md);
  assert.equal(result.isFirstPush, false);
  assert.equal(result.changed.length, 0);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(result.unchanged.sort(), ["Dependencies", "Repo header", "Structure"]);
  assert.equal(result.summary, "No changes detected");
});

test("diffMarkdown: detects a changed section without flagging untouched ones", () => {
  const oldMd = `## Structure\na\n\n## Dependencies\nb`;
  const newMd = `## Structure\na-CHANGED\n\n## Dependencies\nb`;
  const result = diffMarkdown(oldMd, newMd);
  assert.deepEqual(result.changed, ["Structure"]);
  assert.deepEqual(result.unchanged.sort(), ["Dependencies", "Repo header"]);
});

test("diffMarkdown: detects added and removed sections together", () => {
  const oldMd = `## Structure\na\n\n## OldSection\nz`;
  const newMd = `## Structure\na\n\n## NewSection\ny`;
  const result = diffMarkdown(oldMd, newMd);
  assert.deepEqual(result.added, ["NewSection"]);
  assert.deepEqual(result.removed, ["OldSection"]);
  assert.deepEqual(result.unchanged.sort(), ["Repo header", "Structure"]);
});

test("diffMarkdown: a change ABOVE the first ## header (repo description) is caught, not silently ignored", () => {
  const oldMd = `# Repo: acme/widgets\nOriginal description\n\n## Structure\na`;
  const newMd = `# Repo: acme/widgets\nDESCRIPTION CHANGED\n\n## Structure\na`;
  const result = diffMarkdown(oldMd, newMd);
  assert.deepEqual(result.changed, ["Repo header"]);
  assert.notEqual(result.summary, "No changes detected");
});

test("capacityWarning: under 80% is ok with no message", () => {
  const r = capacityWarning(1000, 10000);
  assert.equal(r.level, "ok");
  assert.equal(r.message, null);
});

test("capacityWarning: 80-99% warns", () => {
  const r = capacityWarning(8500, 10000);
  assert.equal(r.level, "warn");
  assert.ok(r.message.includes("85%"));
});

test("capacityWarning: >=100% is over", () => {
  const r = capacityWarning(12000, 10000);
  assert.equal(r.level, "over");
  assert.ok(r.message.includes("exceeds"));
});

test("capacityWarning: default cap is 200,000", () => {
  assert.equal(DEFAULT_TOKEN_CAP, 200000);
});

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
    _dump: () => store,
  };
}

await testAsync("projectStore: create then list round-trips correctly", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("aml-motors", "AML Motors", "org/aml-motors");
  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "aml-motors");
  assert.equal(all[0].repo, "org/aml-motors");
  assert.equal(all[0].lastPushedMarkdown, null);
});

await testAsync("projectStore: create rejects duplicate ids", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("dup", "Dup", "org/dup");
  await assert.rejects(() => store.create("dup", "Dup", "org/dup"), /already exists/);
});

await testAsync("projectStore: recordPush updates state and prepends history", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p1", "P1", "org/p1");
  await store.recordPush("p1", { markdown: "## A\nx", tokens: 100, changeSummary: "first push" });
  await store.recordPush("p1", { markdown: "## A\ny", tokens: 120, changeSummary: "1 section changed" });

  const p = await store.get("p1");
  assert.equal(p.lastPushedMarkdown, "## A\ny");
  assert.equal(p.lastPushedTokens, 120);
  assert.equal(p.history.length, 2);
  assert.equal(p.history[0].changeSummary, "1 section changed");
});

await testAsync("projectStore: recordPush caps history at 10 entries", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p2", "P2", "org/p2");
  for (let i = 0; i < 15; i++) {
    await store.recordPush("p2", { markdown: `## A\n${i}`, tokens: i, changeSummary: `push ${i}` });
  }
  const p = await store.get("p2");
  assert.equal(p.history.length, 10);
  assert.equal(p.history[0].changeSummary, "push 14");
});

await testAsync("projectStore: recordPush on unknown id throws", async () => {
  const store = createProjectStore(makeMockAdapter());
  await assert.rejects(() => store.recordPush("ghost", { markdown: "x", tokens: 1, changeSummary: "" }), /Unknown project/);
});

await testAsync("projectStore: remove deletes the project", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p3", "P3", "org/p3");
  await store.remove("p3");
  assert.equal(await store.get("p3"), null);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) console.log("SOME TESTS FAILED — see FAIL lines above.");

// ============================================================
// PHASE 3 — fileCache persistence (SHA-skip cache round-trip)
// ============================================================

await testAsync("projectStore: a new project starts with an empty fileCache", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p4", "P4", "org/p4");
  const p = await store.get("p4");
  assert.deepEqual(p.fileCache, {}, "new projects must default to an empty cache, not undefined");
});

await testAsync("projectStore: recordPush stores a fileCache and get() returns it", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p5", "P5", "org/p5");
  const cache = { "package.json": { sha: "abc", content: "{}" } };
  await store.recordPush("p5", { markdown: "## A\nx", tokens: 10, changeSummary: "first push", fileCache: cache });
  const p = await store.get("p5");
  assert.deepEqual(p.fileCache, cache);
});

await testAsync("projectStore: recordPush WITHOUT a fileCache arg doesn't crash and preserves the previous cache", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p6", "P6", "org/p6");
  const cache = { "index.js": { sha: "xyz", content: "console.log(1)" } };
  await store.recordPush("p6", { markdown: "## A\nx", tokens: 10, changeSummary: "first push", fileCache: cache });
  // Second push omits fileCache entirely — must not throw, must not silently wipe the cache.
  await store.recordPush("p6", { markdown: "## A\ny", tokens: 12, changeSummary: "second push" });
  const p = await store.get("p6");
  assert.deepEqual(p.fileCache, cache, "omitting fileCache on a push must preserve whatever was there before, not erase it");
});

await testAsync("projectStore: get() on a project stored BEFORE this field existed still works (migration safety)", async () => {
  // Simulates real user data from before this update: no fileCache key at all in storage.
  const adapter = makeMockAdapter();
  await adapter.set({
    projects: {
      "legacy-project": {
        name: "Legacy",
        repo: "org/legacy",
        lastPushedMarkdown: "## Old\ncontent",
        lastPushedTokens: 500,
        lastPushedAt: "2025-01-01T00:00:00.000Z",
        history: [],
        // no fileCache field — this is what pre-update stored data actually looks like
      },
    },
  });
  const store = createProjectStore(adapter);
  const p = await store.get("legacy-project");
  assert.equal(p.name, "Legacy", "existing fields must still read correctly");
  assert.deepEqual(p.fileCache, {}, "a legacy project missing fileCache must not crash — it should default to an empty object");
});

await testAsync("projectStore: recordPush on a legacy project (no prior fileCache) with a new cache doesn't crash", async () => {
  const adapter = makeMockAdapter();
  await adapter.set({
    projects: {
      "legacy2": { name: "Legacy2", repo: "org/legacy2", lastPushedMarkdown: null, lastPushedTokens: 0, lastPushedAt: null, history: [] },
    },
  });
  const store = createProjectStore(adapter);
  const newCache = { "a.js": { sha: "1", content: "x" } };
  await store.recordPush("legacy2", { markdown: "## A\nx", tokens: 5, changeSummary: "push", fileCache: newCache });
  const p = await store.get("legacy2");
  assert.deepEqual(p.fileCache, newCache);
});

console.log(`\n${passed} test(s) passed total.`);
if (process.exitCode) console.log("SOME TESTS FAILED — see FAIL lines above.");
