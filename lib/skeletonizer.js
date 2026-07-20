// lib/skeletonizer.js
// Tier 1 (Map) + Entry-File Heuristic.
// Rule from the spec: no filename gets a free pass. Entry files are detected
// manifest-first (language-aware), filename patterns are a fallback only,
// and EVERY detected entry file still goes through the size cap before
// being included in full.

export const ENTRY_SIZE_CAP_LINES = 150;

const IGNORE_DIR_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)vendor(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.?venv(\/|$)/, // matches both venv/ and .venv/ (python -m venv .venv is common)
  /(^|\/)coverage(\/|$)/,
  /(^|\/)target(\/|$)/, // Rust/Java/Scala build output
  /(^|\/)out(\/|$)/, // Next.js export, various build tools
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

// Manifest files we know how to read, per language. Checked in this order.
const MANIFEST_LOOKUP = [
  { path: "package.json", lang: "node" },
  { path: "pyproject.toml", lang: "python" },
  { path: "requirements.txt", lang: "python" },
  { path: "go.mod", lang: "go" },
  { path: "Cargo.toml", lang: "rust" },
];

// Fallback filename patterns — ONLY used if the manifest didn't already
// point us at an entry file. Filename alone never grants inclusion; it
// just nominates a candidate, which still hits the size cap below.
const FALLBACK_ENTRY_PATTERNS = [
  /(^|\/)index\.(js|ts|jsx|tsx)$/,
  /(^|\/)main\.(py|go|rs)$/,
  /(^|\/)app\.(py|js|ts)$/,
  /(^|\/)server\.(js|ts)$/,
  /(^|\/)cmd\/[^/]+\/main\.go$/,
];

export function filterTree(tree) {
  const kept = [];
  const trimmed = { dirs: 0, files: 0 };

  for (const entry of tree) {
    if (entry.type !== "blob") continue; // skip tree/commit entries, keep files only
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

  const CAP = 2000;
  if (text.length > CAP) {
    text = truncateSafely(text, CAP).trim() + "\n\n...(README truncated for Tier 1 — full version available on request)";
  }
  return text;
}

/**
 * Truncate at or before `cap`, without ever leaving an odd number of ``` fences
 * (which would make everything after it in the assembled markdown render as
 * "inside a code block"). Falls back further to the nearest blank-line boundary
 * for readability, when doing so doesn't cross another fence boundary.
 */
function truncateSafely(text, cap) {
  let cut = Math.min(cap, text.length);

  // If the raw cut point lands inside an open fence, pull back to just before
  // that fence opened — never forward, since forward could exceed the cap.
  const fenceOpenBefore = (s) => (s.match(/```/g) || []).length % 2 === 1;
  if (fenceOpenBefore(text.slice(0, cut))) {
    const lastFenceStart = text.lastIndexOf("```", cut);
    if (lastFenceStart > 0) cut = lastFenceStart;
  }

  // Prefer a paragraph boundary at or before `cut`, as long as it doesn't
  // reopen the fence-safety problem we just solved.
  const paragraphBreak = text.lastIndexOf("\n\n", cut);
  if (paragraphBreak > 0 && !fenceOpenBefore(text.slice(0, paragraphBreak))) {
    cut = paragraphBreak;
  }

  return text.slice(0, cut);
}

export function findManifestFile(filteredPaths) {
  for (const candidate of MANIFEST_LOOKUP) {
    if (filteredPaths.has(candidate.path)) return candidate;
  }
  return null;
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
      };
    }

    if (manifest.lang === "python" && manifest.path === "requirements.txt") {
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => `- ${l}`);
      return { text: `Dependencies:\n${lines.join("\n")}`, mainEntry: null, startScript: null };
    }

    if (manifest.lang === "go") {
      const moduleLine = content.split("\n").find((l) => l.startsWith("module "));
      return {
        text: moduleLine ? `**${moduleLine}**` : "(go.mod found, module line not detected)",
        mainEntry: null,
        startScript: null,
      };
    }

    return { text: `(${manifest.path} present — full dependency parse deferred to a later tier)`, mainEntry: null, startScript: null };
  } catch (e) {
    return { text: `(couldn't parse ${manifest.path}: ${e.message})`, mainEntry: null, startScript: null };
  }
}

export function detectEntryFileCandidates(filteredPaths, manifestSummary) {
  const candidates = new Set();

  if (manifestSummary) {
    if (manifestSummary.mainEntry) {
      candidates.add(normalizeRelPath(manifestSummary.mainEntry));
    }
    if (manifestSummary.startScript) {
      const match = manifestSummary.startScript.match(/([./\w-]+\.(js|ts|py|go))/);
      if (match) candidates.add(normalizeRelPath(match[1]));
    }
  }

  for (const path of filteredPaths) {
    if (FALLBACK_ENTRY_PATTERNS.some((p) => p.test(path))) {
      candidates.add(path);
    }
  }

  return [...candidates].filter((p) => filteredPaths.has(p));
}

function normalizeRelPath(p) {
  return p.replace(/^\.\//, "");
}

export function classifyEntryFiles(candidates, filesByPath, contentByPath) {
  const included = [];
  const skeletonized = [];
  const failed = [];

  for (const path of candidates) {
    const content = contentByPath[path];
    if (content == null) {
      failed.push({ path, reason: "fetch failed or was skipped" });
      continue;
    }

    const lineCount = content.split("\n").length;
    if (lineCount <= ENTRY_SIZE_CAP_LINES) {
      included.push({ path, lineCount, content });
    } else {
      skeletonized.push({ path, lineCount });
    }
  }
  return { included, skeletonized, failed };
}

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Decide, per path, whether cached content can be reused or must be refetched.
 * A path is reused ONLY if:
 *   - it currently exists in the tree (keptByPath has an entry for it)
 *   - a cache entry exists for it
 *   - both shas are present (non-null) AND equal
 * Any other case (no tree entry, no cache entry, null sha on either side,
 * mismatched sha) falls through to "must fetch" — never trust an absence
 * of information as a match. This is the safety property that makes the
 * cache trustworthy: worst case is a redundant fetch, never stale content
 * silently served as current.
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