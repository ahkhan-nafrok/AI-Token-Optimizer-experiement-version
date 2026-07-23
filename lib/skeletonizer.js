// lib/skeletonizer.js
// Tier 1 (Map) + Tier 2 (Signatures) + Relationship extraction.
// Designed for ONE reader: Claude. The goal of every function here is to
// produce a real structural fact — not just "here's a file" — because an
// LLM reasoning about a codebase needs relationships and shape, not just
// content. Deterministic and dependency-free by design (no parser libs,
// no middle LLM) so the whole pipeline stays testable and trustworthy.

export const ENTRY_SIZE_CAP_LINES = 150;

// Anything bigger than this (bytes, from GitHub's tree `size` field) is never
// fetched at all — it goes straight to "skeletonized, size-guarded" using only
// the size GitHub already told us, instead of downloading a huge file just to
// discard it after counting lines. This is the fix for the known bug where a
// large accidental file (e.g. a bundled main.js) got fully fetched before
// being classified.
export const ENTRY_SIZE_PREFETCH_GUARD_BYTES = 20000;

const IGNORE_DIR_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)vendor(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.?venv(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)out(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /(^|\/)\.nuxt(\/|$)/,
  /(^|\/)\.svelte-kit(\/|$)/,
];

const IGNORE_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|mp4|mp3|zip|tar|gz)$/i,
  /\.map$/,
];

// Manifest basenames we know how to read, per language. Unlike the old
// single-lookup table, this now matches by BASENAME anywhere in the tree —
// so a monorepo with packages/api/package.json and packages/web/package.json
// gets both discovered, not just a root-level guess.
const MANIFEST_BASENAMES = [
  { basename: "package.json", lang: "node" },
  { basename: "pyproject.toml", lang: "python" },
  { basename: "requirements.txt", lang: "python" },
  { basename: "go.mod", lang: "go" },
  { basename: "Cargo.toml", lang: "rust" },
];

// Fallback filename patterns — ONLY used if manifests didn't already point us
// at an entry file. Filename alone never grants inclusion; it just nominates
// a candidate, which still hits the size cap/guard below.
const FALLBACK_ENTRY_PATTERNS = [
  /(^|\/)index\.(js|ts|jsx|tsx)$/,
  /(^|\/)main\.(py|go|rs)$/,
  /(^|\/)app\.(py|js|ts)$/,
  /(^|\/)server\.(js|ts)$/,
  /(^|\/)cmd\/[^/]+\/main\.go$/,
  // Framework-convention entries — filename alone still doesn't grant
  // inclusion, just candidacy, same as everything else above.
  /(^|\/)app\/page\.(js|jsx|ts|tsx)$/, // Next.js App Router root page
  /(^|\/)pages\/index\.(js|jsx|ts|tsx)$/, // Next.js Pages Router root page
  /(^|\/)manage\.py$/, // Django
  /(^|\/)src\/main\.rs$/, // Rust binary crate root
  /(^|\/)src\/lib\.rs$/, // Rust library crate root
  // Static/browser-native entry conventions — a plain HTML+JS app or a
  // browser extension often has no package.json main/start at all, so
  // filename fallback matters more here, not less.
  /(^|\/)index\.html$/,
  /(^|\/)popup\.(js|ts)$/,
  /(^|\/)background\.(js|ts)$/,
  /(^|\/)content\.(js|ts)$/,
  /(^|\/)options\.(js|ts|html)$/,
];

/**
 * Chrome/Firefox extension manifest.json is a DIFFERENT concept from the
 * language manifests above (package.json/etc. for dependencies) — it's a
 * platform manifest that names actual entry points directly (popup, options,
 * background, content scripts). When present, it's the single most reliable
 * entry-file signal for an extension, more reliable than any filename guess.
 */
export function detectManifestJsonEntryPoints(content) {
  try {
    const manifest = JSON.parse(content);
    const entries = new Set();
    const add = (v) => {
      if (typeof v === "string" && v.trim()) entries.add(v.replace(/^\.\//, ""));
    };

    add(manifest.action?.default_popup);
    add(manifest.browser_action?.default_popup); // Manifest V2
    add(manifest.options_page);
    add(manifest.options_ui?.page);
    add(manifest.background?.service_worker); // Manifest V3
    if (Array.isArray(manifest.background?.scripts)) manifest.background.scripts.forEach(add); // Manifest V2
    if (Array.isArray(manifest.content_scripts)) {
      for (const cs of manifest.content_scripts) {
        if (Array.isArray(cs.js)) cs.js.forEach(add);
      }
    }

    return {
      isExtensionManifest: true,
      manifestVersion: manifest.manifest_version || null,
      entries: [...entries],
    };
  } catch (e) {
    return { isExtensionManifest: false, manifestVersion: null, entries: [] };
  }
}

/**
 * A referenced HTML entry (e.g. popup.html) usually pulls in its real logic
 * via <script src="...">. Following that reference is what lets Claude see
 * "popup.html loads popup.js" instead of stopping at the HTML shell.
 */
export function extractHtmlScriptRefs(content, dir = "") {
  const refs = [];
  const re = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(content))) {
    const src = m[1];
    if (/^https?:\/\//.test(src) || src.startsWith("//")) continue; // external, not local
    refs.push(joinRelPath(dir, src));
  }
  return [...new Set(refs)];
}

export function filterTree(tree) {
  const kept = [];
  const trimmed = { dirs: 0, files: 0 };

  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const path = entry.path;

    if (IGNORE_DIR_PATTERNS.some((p) => p.test(path))) {
      trimmed.dirs++;
      continue;
    }
    if (IGNORE_FILE_PATTERNS.some((p) => p.test(path))) {
      trimmed.files++;
      continue;
    }
    kept.push({ path, size: entry.size || 0, sha: entry.sha || null });
  }
  return { kept, trimmed };
}

export function buildFileTreeText(files) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sorted.map((f) => f.path).join("\n");
}

export function condenseReadme(raw) {
  if (!raw) return "(no README found)";

  let text = raw;
  text = text.replace(/^\[!\[.*?\]\(.*?\)\]\(.*?\)\s*$/gm, "");
  text = text.replace(/^!\[.*?\]\(.*?\)\s*$/gm, "");
  text = text.replace(/##\s*License[\s\S]*$/im, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  // README is always fetched fresh (single cheap call, never cached/skipped —
  // see governing rules), so there's no real cost reason for an aggressive
  // cap. The old 2000-char cap was cutting real setup/usage instructions off
  // mid-document on anything longer than a short blurb. 8000 chars comfortably
  // covers a full multi-section README/setup guide while still protecting
  // against a truly massive README dominating the token budget.
  const CAP = 8000;
  if (text.length > CAP) {
    text = truncateSafely(text, CAP).trim() + "\n\n...(README truncated for Tier 1 — full version available on request)";
  }
  return text;
}

function truncateSafely(text, cap) {
  let cut = Math.min(cap, text.length);
  const fenceOpenBefore = (s) => (s.match(/```/g) || []).length % 2 === 1;
  if (fenceOpenBefore(text.slice(0, cut))) {
    const lastFenceStart = text.lastIndexOf("```", cut);
    if (lastFenceStart > 0) cut = lastFenceStart;
  }
  const paragraphBreak = text.lastIndexOf("\n\n", cut);
  if (paragraphBreak > 0 && !fenceOpenBefore(text.slice(0, paragraphBreak))) {
    cut = paragraphBreak;
  }
  return text.slice(0, cut);
}

/**
 * Discover ALL manifest files in the tree (monorepo-aware), not just one.
 * Sorted root-first (shallowest path first) since the root project's
 * dependencies matter most when there's ambiguity about priority.
 */
export function findManifestFiles(filteredPaths) {
  const found = [];
  for (const path of filteredPaths) {
    const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const match = MANIFEST_BASENAMES.find((m) => m.basename === base);
    if (match) {
      const depth = path.includes("/") ? path.split("/").length - 1 : 0;
      found.push({ path, lang: match.lang, depth });
    }
  }
  found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return found;
}

/** Back-compat single-manifest accessor: the root-most manifest found. */
export function findManifestFile(filteredPaths) {
  const all = findManifestFiles(filteredPaths);
  return all.length ? all[0] : null;
}

export function summarizeManifest(manifest, content) {
  try {
    if (manifest.lang === "node") {
      const pkg = JSON.parse(content);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const lines = Object.entries(deps).map(([name, ver]) => `- ${name}: ${ver}`);
      const scripts = pkg.scripts
        ? Object.entries(pkg.scripts).map(([k, v]) => `- ${k}: ${v}`)
        : [];
      return {
        text: [
          `**${pkg.name || "package"}**${pkg.version ? ` v${pkg.version}` : ""}`,
          lines.length ? `\nDependencies:\n${lines.join("\n")}` : "",
          scripts.length ? `\nScripts:\n${scripts.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        mainEntry: pkg.main || null,
        startScript: pkg.scripts && pkg.scripts.start ? pkg.scripts.start : null,
        workspaces: pkg.workspaces
          ? Array.isArray(pkg.workspaces)
            ? pkg.workspaces
            : pkg.workspaces.packages || null
          : null,
      };
    }

    if (manifest.lang === "python" && manifest.path.endsWith("requirements.txt")) {
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => `- ${l}`);
      return { text: `Dependencies:\n${lines.join("\n")}`, mainEntry: null, startScript: null, workspaces: null };
    }

    if (manifest.lang === "go") {
      const moduleLine = content.split("\n").find((l) => l.startsWith("module "));
      return {
        text: moduleLine ? `**${moduleLine}**` : "(go.mod found, module line not detected)",
        mainEntry: null,
        startScript: null,
        workspaces: null,
      };
    }

    return {
      text: `(${manifest.path} present — full dependency parse deferred to a later tier)`,
      mainEntry: null,
      startScript: null,
      workspaces: null,
    };
  } catch (e) {
    return { text: `(couldn't parse ${manifest.path}: ${e.message})`, mainEntry: null, startScript: null, workspaces: null };
  }
}

/**
 * Assemble the "## Dependencies" section text from one or more manifest
 * summaries. Single-manifest repos (the overwhelming common case) get
 * exactly the old single-block output — no format change, nothing to
 * relearn. Multi-manifest (monorepo) repos get grouped, labeled sections
 * instead of silently picking one and hiding the rest.
 */
export function assembleManifestSection(summaries) {
  if (!summaries.length) return "(no recognized manifest file found)";
  if (summaries.length === 1) return summaries[0].text;

  const parts = summaries.map((s) => `### ${s.path}\n${s.text}`);
  return `**Monorepo detected — ${summaries.length} manifests found.**\n\n${parts.join("\n\n")}`;
}

function joinRelPath(dir, rel) {
  const cleaned = rel.replace(/^\.\//, "");
  return dir ? `${dir}/${cleaned}` : cleaned;
}

/**
 * Detect entry-file candidates across ALL discovered manifests (monorepo-aware)
 * plus fallback filename/framework-convention patterns. Manifest signal always
 * wins priority; filename patterns are a fallback nomination only — every
 * candidate still goes through size cap/guard before being included in full.
 */
export function detectEntryFileCandidates(filteredPaths, manifestSummaries = []) {
  const candidates = new Set();

  for (const summary of manifestSummaries) {
    const dir = summary.dir || "";
    if (summary.mainEntry) candidates.add(joinRelPath(dir, summary.mainEntry));
    if (summary.startScript) {
      const match = summary.startScript.match(/([./\w-]+\.(js|ts|py|go))/);
      if (match) candidates.add(joinRelPath(dir, match[1]));
    }
  }

  for (const path of filteredPaths) {
    if (FALLBACK_ENTRY_PATTERNS.some((p) => p.test(path))) candidates.add(path);
  }

  return [...candidates].filter((p) => filteredPaths.has(p));
}

/** Defensive, size-based pre-fetch guard using GitHub's tree `size` field. */
export function shouldSkipFetchForSize(path, keptByPath) {
  const entry = keptByPath[path];
  if (!entry || entry.size == null) return false; // no size info — can't guard, fetch as before
  return entry.size > ENTRY_SIZE_PREFETCH_GUARD_BYTES;
}

/**
 * Regex-based signature extraction for files that are over the inclusion cap.
 * Deliberately NOT a real parser — no per-language dependency, stays fast and
 * dependency-free, and "good enough" signatures beat "nothing at all," which
 * is what over-cap files got before (just a line-count note). Best-effort by
 * design: unrecognized languages return an empty list, handled gracefully by
 * the caller.
 */
export function extractSignatures(content, path) {
  const ext = extOf(path);
  const lines = content.split("\n");
  const sigs = [];
  const push = (i, text) => sigs.push({ line: i + 1, signature: text.trim() });

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) {
    const patterns = [
      /^\s*export\s+default\s+(async\s+)?function\s*\w*\s*\(/,
      /^\s*export\s+(async\s+)?function\s+\w+\s*\(/,
      /^\s*(async\s+)?function\s+\w+\s*\(/,
      /^\s*export\s+default\s+class\s+\w+/,
      /^\s*export\s+class\s+\w+/,
      /^\s*class\s+\w+/,
      /^\s*export\s+const\s+\w+\s*=\s*(async\s*)?\(/,
      /^\s*export\s+const\s+\w+\s*=/,
      /^\s*module\.exports\s*=/,
      /^\s*exports\.\w+\s*=/,
    ];
    lines.forEach((line, i) => {
      if (patterns.some((p) => p.test(line))) push(i, line);
    });
  } else if (ext === "py") {
    lines.forEach((line, i) => {
      if (/^\s*(async\s+)?def\s+\w+\s*\(/.test(line) || /^\s*class\s+\w+/.test(line)) push(i, line);
    });
  } else if (ext === "go") {
    lines.forEach((line, i) => {
      if (/^\s*func\s+(\(\s*\w+\s+\*?\w+\s*\)\s+)?\w+\s*\(/.test(line) || /^\s*type\s+\w+\s+(struct|interface)/.test(line)) {
        push(i, line);
      }
    });
  } else if (ext === "rs") {
    lines.forEach((line, i) => {
      if (
        /^\s*(pub\s+)?(async\s+)?fn\s+\w+\s*\(/.test(line) ||
        /^\s*(pub\s+)?struct\s+\w+/.test(line) ||
        /^\s*impl(\s*<.*?>)?\s+\w+/.test(line)
      ) {
        push(i, line);
      }
    });
  }

  return sigs;
}

/**
 * Best-effort local-import extraction so Claude gets real "A relates to B"
 * facts instead of isolated files. Regex-based on purpose — a full per-language
 * parser is real future scope (flagged, not built now); this heuristic only
 * surfaces LOCAL/relative imports, since external packages are already covered
 * by the manifest/dependencies section and repeating them here is just noise.
 */
export function extractImports(content, path) {
  const ext = extOf(path);
  const lines = content.split("\n");
  const imports = [];

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) {
    for (const line of lines) {
      const esm = line.match(/^\s*import\s+.*?\s+from\s+["'](.+?)["']/);
      if (esm) {
        imports.push(esm[1]);
        continue;
      }
      const cjs = line.match(/require\(\s*["'](.+?)["']\s*\)/);
      if (cjs) imports.push(cjs[1]);
    }
    return [...new Set(imports)].filter((imp) => imp.startsWith(".") || imp.startsWith("/"));
  }

  if (ext === "py") {
    for (const line of lines) {
      const fromImport = line.match(/^\s*from\s+(\.[\w.]*)\s+import\s+/);
      if (fromImport) imports.push(fromImport[1]);
    }
    return [...new Set(imports)];
  }

  if (ext === "go") {
    let inBlock = false;
    for (const line of lines) {
      if (/^\s*import\s*\(/.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock && /^\s*\)/.test(line)) {
        inBlock = false;
        continue;
      }
      const m = inBlock ? line.match(/"([^"]+)"/) : line.match(/^\s*import\s+"([^"]+)"/);
      if (m) imports.push(m[1]);
    }
    // Heuristic: a Go import path with no dot in its first segment is very
    // likely an internal module path rather than a public host (e.g. "github.com/...").
    return [...new Set(imports)].filter((imp) => !/^[\w-]+\.[\w-]+/.test(imp.split("/")[0]));
  }

  if (ext === "rs") {
    for (const line of lines) {
      const m = line.match(/^\s*use\s+(crate|self|super)[\w:]*/);
      if (m) imports.push(line.trim().replace(/;.*$/, ""));
    }
    return [...new Set(imports)];
  }

  return [];
}

function extOf(path) {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i + 1).toLowerCase();
}

/**
 * Classify each entry-file candidate as included (full content, under cap),
 * skeletonized (over cap — gets Tier 2 signatures if fetched, or a size-guard
 * note if never fetched at all), or failed (fetch attempted and lost).
 * `keptByPath` is used to recognize size-guard-skipped paths that were never
 * fetched in the first place, vs. genuine fetch failures.
 */
export function classifyEntryFiles(candidates, filesByPath, contentByPath, keptByPath = {}) {
  const included = [];
  const skeletonized = [];
  const failed = [];

  for (const path of candidates) {
    const hasContent = Object.prototype.hasOwnProperty.call(contentByPath, path);

    if (!hasContent) {
      const treeEntry = keptByPath[path];
      if (treeEntry && treeEntry.size > ENTRY_SIZE_PREFETCH_GUARD_BYTES) {
        skeletonized.push({
          path,
          lineCount: null,
          estimatedLineCount: Math.round(treeEntry.size / 50),
          skippedFetch: true,
        });
        continue;
      }
      failed.push({ path, reason: "fetch failed or was skipped" });
      continue;
    }

    const content = contentByPath[path];
    if (content == null) {
      failed.push({ path, reason: "fetch failed or was skipped" });
      continue;
    }

    const lineCount = content.split("\n").length;
    if (lineCount <= ENTRY_SIZE_CAP_LINES) {
      included.push({ path, lineCount, content });
    } else {
      const signatures = extractSignatures(content, path);
      skeletonized.push({ path, lineCount, signatures });
    }
  }
  return { included, skeletonized, failed };
}

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Decide, per path, whether cached content can be reused or must be refetched.
 * Defensive by design: missing sha, missing cache entry, or mismatched sha
 * always falls through to "must fetch" — worst case is a redundant fetch,
 * never stale content served silently.
 */
export function planContentFetches(paths, keptByPath, cache = {}) {
  const toFetch = [];
  const reused = [];

  for (const path of paths) {
    const treeEntry = keptByPath[path];
    const cached = cache[path];

    const treeSha = treeEntry ? treeEntry.sha : null;
    const cachedSha = cached ? cached.sha : null;

    if (treeSha && cachedSha && treeSha === cachedSha) {
      reused.push({ path, sha: cachedSha, content: cached.content });
    } else {
      toFetch.push(path);
    }
  }

  return { toFetch, reused };
}