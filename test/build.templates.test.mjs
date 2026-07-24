// test/build.templates.test.mjs
// Covers the new template-rendering layer: TEMPLATES config, renderWithTemplate,
// and confirms the DEFAULT (untemplated) build output is completely unaffected.
// Run with: node test/build.templates.test.mjs

import assert from "node:assert/strict";
import { buildTier1, renderWithTemplate, TEMPLATES, SECTION_HEADERS } from "../lib/build.js";

function b64(s) {
  return Buffer.from(s, "utf-8").toString("base64");
}

function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj };
}

const PKG_JSON = JSON.stringify({ name: "fake-pkg", version: "1.0.0", main: "index.js" });
const INDEX_JS = "import { doWork } from './worker.js';\n\nexport function main() {\n  return doWork();\n}\n";

function makeMockFetch({ readme = "# Fake\n\nA fake readme." } = {}) {
  return async (url) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u) && !u.includes("/git/") && !u.includes("/readme") && !u.includes("/contents/")) {
      return jsonResponse({ default_branch: "main", description: "Fake repo", language: "JavaScript", pushed_at: "2026-01-01T00:00:00Z" });
    }
    if (u.includes("/git/trees/")) {
      return jsonResponse({
        tree: [
          { type: "blob", path: "package.json", size: PKG_JSON.length, sha: "sha-pkg" },
          { type: "blob", path: "index.js", size: INDEX_JS.length, sha: "sha-index" },
        ],
        truncated: false,
      });
    }
    if (u.includes("/readme")) {
      return jsonResponse({ content: b64(readme), encoding: "base64" });
    }
    if (u.includes("/contents/package.json")) {
      return jsonResponse({ content: b64(PKG_JSON), encoding: "base64" });
    }
    if (u.includes("/contents/index.js")) {
      return jsonResponse({ content: b64(INDEX_JS), encoding: "base64" });
    }
    throw new Error(`Unhandled mock URL: ${u}`);
  };
}

const originalFetch = globalThis.fetch;
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

async function run() {
  globalThis.fetch = makeMockFetch();
  const build = await buildTier1("fake/repo", null, () => {});

  await test("buildTier1 still returns the original default markdown, unaffected by the template feature", () => {
    assert.ok(build.markdown.includes("## README (condensed)"));
    assert.ok(build.markdown.includes("## Structure"));
    assert.ok(build.markdown.includes("## Dependencies"));
    assert.ok(build.markdown.includes("## Entry points"));
    assert.ok(build.markdown.includes("## Relationships"));
    // Default order preserved exactly as before templates existed.
    const order = [
      build.markdown.indexOf("## README"),
      build.markdown.indexOf("## Structure"),
      build.markdown.indexOf("## Dependencies"),
      build.markdown.indexOf("## Entry points"),
      build.markdown.indexOf("## Relationships"),
    ];
    for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], "default section order must be unchanged");
  });

  await test("buildTier1 additionally exposes .preamble and .sections for template rendering", () => {
    assert.ok(typeof build.preamble === "string" && build.preamble.includes("fake/repo"));
    assert.ok(build.sections[SECTION_HEADERS.README]);
    assert.ok(build.sections[SECTION_HEADERS.STRUCTURE]);
    assert.ok(build.sections[SECTION_HEADERS.DEPENDENCIES]);
    assert.ok(build.sections[SECTION_HEADERS.ENTRY_POINTS]);
    assert.ok(build.sections[SECTION_HEADERS.RELATIONSHIPS]);
  });

  await test("renderWithTemplate('onboarding') puts Relationships and Entry points before Structure/Dependencies/README", () => {
    const out = renderWithTemplate(build, "onboarding");
    const idx = (h) => out.indexOf(`## ${h}`);
    assert.ok(idx(SECTION_HEADERS.RELATIONSHIPS) < idx(SECTION_HEADERS.ENTRY_POINTS));
    assert.ok(idx(SECTION_HEADERS.ENTRY_POINTS) < idx(SECTION_HEADERS.STRUCTURE));
    assert.ok(idx(SECTION_HEADERS.STRUCTURE) < idx(SECTION_HEADERS.DEPENDENCIES));
    assert.ok(idx(SECTION_HEADERS.DEPENDENCIES) < idx(SECTION_HEADERS.README));
    assert.ok(out.includes(TEMPLATES.onboarding.framing), "onboarding framing sentence must be present");
  });

  await test("renderWithTemplate('audit') puts Dependencies first, README last", () => {
    const out = renderWithTemplate(build, "audit");
    const idx = (h) => out.indexOf(`## ${h}`);
    assert.ok(idx(SECTION_HEADERS.DEPENDENCIES) < idx(SECTION_HEADERS.STRUCTURE));
    assert.ok(idx(SECTION_HEADERS.STRUCTURE) < idx(SECTION_HEADERS.ENTRY_POINTS));
    assert.ok(idx(SECTION_HEADERS.ENTRY_POINTS) < idx(SECTION_HEADERS.RELATIONSHIPS));
    assert.ok(idx(SECTION_HEADERS.RELATIONSHIPS) < idx(SECTION_HEADERS.README));
    assert.ok(out.includes(TEMPLATES.audit.framing), "audit framing sentence must be present");
  });

  await test("renderWithTemplate never mutates the underlying build result (pure function)", () => {
    const before = JSON.stringify(build.sections);
    renderWithTemplate(build, "onboarding");
    renderWithTemplate(build, "audit");
    assert.equal(JSON.stringify(build.sections), before, "sections must be untouched after rendering templates");
  });

  await test("renderWithTemplate throws clearly on an unknown template id", () => {
    assert.throws(() => renderWithTemplate(build, "nonexistent"), /Unknown template/);
  });

  // ---- Empty-section skipping: README missing (repo with no README) ----
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/readme")) {
      // Simulate GitHub 404 on the readme endpoint the way lib/github.js
      // already handles it: getReadme() catches and returns null.
      throw new Error("simulated 404");
    }
    return makeMockFetch()(url);
  };
  const buildNoReadme = await buildTier1("fake/repo", null, () => {});

  await test("a repo with no README omits the README section entirely under a template (no empty header)", () => {
    const out = renderWithTemplate(buildNoReadme, "onboarding");
    assert.ok(!out.includes(`## ${SECTION_HEADERS.README}`), "README header must not render when the section is genuinely empty");
  });

  await test("the DEFAULT (untemplated) build still shows the README section even when empty — templates don't change default behavior", () => {
    assert.ok(buildNoReadme.markdown.includes(`## ${SECTION_HEADERS.README}`), "default assembly always shows all five sections, unchanged");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

run()
  .catch((e) => {
    console.error("FAIL -", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
