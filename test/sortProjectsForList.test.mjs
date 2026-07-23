// test/sortProjectsForList.test.mjs
// Pure logic test for the new pinned + GitHub-commit-recency list ordering.
// Run with: node test/sortProjectsForList.test.mjs

import assert from "node:assert/strict";
import { sortProjectsForList } from "../projectsView.js";

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

test("pinned projects sort before unpinned ones, regardless of commit recency", () => {
  const projects = [
    { name: "Unpinned-Fresh", pinned: false, lastCommitAt: "2026-07-20T00:00:00.000Z" },
    { name: "Pinned-Old", pinned: true, lastCommitAt: "2024-01-01T00:00:00.000Z" },
  ];
  const sorted = sortProjectsForList(projects);
  assert.equal(sorted[0].name, "Pinned-Old", "a pinned project must sort first even if its commit is older");
  assert.equal(sorted[1].name, "Unpinned-Fresh");
});

test("among pinned projects, most-recent commit sorts first (recency)", () => {
  const projects = [
    { name: "Pinned-Old", pinned: true, lastCommitAt: "2024-01-01T00:00:00.000Z" },
    { name: "Pinned-New", pinned: true, lastCommitAt: "2026-06-01T00:00:00.000Z" },
  ];
  const sorted = sortProjectsForList(projects);
  assert.deepEqual(sorted.map((p) => p.name), ["Pinned-New", "Pinned-Old"]);
});

test("among unpinned projects, most-recent GitHub commit sorts first", () => {
  const projects = [
    { name: "Old", pinned: false, lastCommitAt: "2024-01-01T00:00:00.000Z" },
    { name: "New", pinned: false, lastCommitAt: "2026-01-01T00:00:00.000Z" },
    { name: "Mid", pinned: false, lastCommitAt: "2025-01-01T00:00:00.000Z" },
  ];
  const sorted = sortProjectsForList(projects);
  assert.deepEqual(sorted.map((p) => p.name), ["New", "Mid", "Old"]);
});

test("a never-checked project (no lastCommitAt) bubbles to the top of its own group (pinned or unpinned)", () => {
  const projects = [
    { name: "Checked", pinned: false, lastCommitAt: "2026-01-01T00:00:00.000Z" },
    { name: "NeverChecked", pinned: false, lastCommitAt: null },
  ];
  const sorted = sortProjectsForList(projects);
  assert.equal(sorted[0].name, "NeverChecked", "an unchecked project needs attention first, so it sorts ahead of a checked one");
});

test("multiple never-checked projects (same group) sort alphabetically among themselves", () => {
  const projects = [
    { name: "Charlie", pinned: false, lastCommitAt: null },
    { name: "Alpha", pinned: false, lastCommitAt: null },
    { name: "Bravo", pinned: false, lastCommitAt: null },
  ];
  const sorted = sortProjectsForList(projects);
  assert.deepEqual(sorted.map((p) => p.name), ["Alpha", "Bravo", "Charlie"]);
});

test("a realistic mixed set: pinned block (recency), then unpinned block (never-checked first, then recency)", () => {
  const projects = [
    { name: "Unpinned-Old", pinned: false, lastCommitAt: "2024-06-01T00:00:00.000Z" },
    { name: "Pinned-NeverChecked", pinned: true, lastCommitAt: null },
    { name: "Unpinned-New", pinned: false, lastCommitAt: "2026-06-01T00:00:00.000Z" },
    { name: "Pinned-Checked", pinned: true, lastCommitAt: "2025-01-01T00:00:00.000Z" },
    { name: "Unpinned-NeverChecked", pinned: false, lastCommitAt: null },
  ];
  const sorted = sortProjectsForList(projects);
  assert.deepEqual(sorted.map((p) => p.name), [
    "Pinned-NeverChecked",
    "Pinned-Checked",
    "Unpinned-NeverChecked",
    "Unpinned-New",
    "Unpinned-Old",
  ]);
});

test("does not mutate the input array (pure function)", () => {
  const projects = [
    { name: "B", pinned: false, lastCommitAt: null },
    { name: "A", pinned: false, lastCommitAt: null },
  ];
  const original = [...projects];
  sortProjectsForList(projects);
  assert.deepEqual(projects, original, "the original array reference must not be reordered in place");
});

test("empty list returns empty list without throwing", () => {
  assert.deepEqual(sortProjectsForList([]), []);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
