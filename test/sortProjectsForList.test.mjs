// test/sortProjectsForList.test.mjs
// Pure logic test for the multi-project list ordering. No DOM required —
// importing projectsView.js is safe here because sortProjectsForList doesn't
// touch document at module load time, only inside initProjectsView().
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

test("never-pushed projects sort before pushed ones, regardless of input order", () => {
  const projects = [
    { name: "Zulu", lastPushedAt: "2025-01-01T00:00:00.000Z" },
    { name: "Alpha", lastPushedAt: null },
  ];
  const sorted = sortProjectsForList(projects);
  assert.equal(sorted[0].name, "Alpha", "the never-pushed project must come first");
  assert.equal(sorted[1].name, "Zulu");
});

test("multiple never-pushed projects sort alphabetically among themselves", () => {
  const projects = [
    { name: "Charlie", lastPushedAt: null },
    { name: "Alpha", lastPushedAt: null },
    { name: "Bravo", lastPushedAt: null },
  ];
  const sorted = sortProjectsForList(projects);
  assert.deepEqual(sorted.map((p) => p.name), ["Alpha", "Bravo", "Charlie"]);
});

test("multiple pushed projects sort most-recently-pushed first", () => {
  const projects = [
    { name: "Old", lastPushedAt: "2024-01-01T00:00:00.000Z" },
    { name: "New", lastPushedAt: "2026-01-01T00:00:00.000Z" },
    { name: "Mid", lastPushedAt: "2025-01-01T00:00:00.000Z" },
  ];
  const sorted = sortProjectsForList(projects);
  assert.deepEqual(sorted.map((p) => p.name), ["New", "Mid", "Old"]);
});

test("a realistic mixed set (multi-project scale) groups correctly: pending-alpha, then pushed-recency", () => {
  const projects = [
    { name: "Pushed-Old", lastPushedAt: "2024-06-01T00:00:00.000Z" },
    { name: "Pending-B", lastPushedAt: null },
    { name: "Pushed-New", lastPushedAt: "2026-06-01T00:00:00.000Z" },
    { name: "Pending-A", lastPushedAt: null },
  ];
  const sorted = sortProjectsForList(projects);
  assert.deepEqual(sorted.map((p) => p.name), ["Pending-A", "Pending-B", "Pushed-New", "Pushed-Old"]);
});

test("does not mutate the input array (pure function)", () => {
  const projects = [{ name: "B", lastPushedAt: null }, { name: "A", lastPushedAt: null }];
  const original = [...projects];
  sortProjectsForList(projects);
  assert.deepEqual(projects, original, "the original array reference must not be reordered in place");
});

test("empty list returns empty list without throwing", () => {
  assert.deepEqual(sortProjectsForList([]), []);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
