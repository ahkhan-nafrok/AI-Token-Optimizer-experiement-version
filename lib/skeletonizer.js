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
  /(^|\/)venv(\/|$)/,
  /(^|\/)coverage(\/|$)/,
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
    kept.push({ path, size: entry.size || 0 });
  }
  return { kept, trimmed };
}

export function buildFileTreeText(files) {
  // Simple indented tree from flat paths, sorted so directories group naturally.
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sorted.map((f) => f.path).join("\n");
}

export function condenseReadme(raw) {
  if (!raw) return "(no README found)";

  let text = raw;

  // Strip badge/shield image lines and bare image markdown.
  text = text.replace(/^\[!\[.*?\]\(.*?\)\]\(.*?\)\s*$/gm, "");
  text = text.replace(/^!\[.*?\]\(.*?\)\s*$/gm, "");

  // Strip a trailing License section — boilerplate, not content.
  text = text.replace(/##\s*License[\s\S]*$/im, "");

  // Collapse runs of blank lines.
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  // Cap length — Tier 1 wants "description + usage," not the whole doc.
  const CAP = 2000;
  if (text.length > CAP) {
    text = text.slice(0, CAP).trim() + "\n\n...(README truncated for Tier 1 — full version available on request)";
  }
  return text;
}

export function findManifestFile(filteredPaths) {
  for (const candidate of MANIFEST_LOOKUP) {
    if (filteredPaths.has(candidate.path)) return candidate;
  }
  return null;
}

/** Summarize a manifest to dependency names + versions only — never the full file. */
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

    // pyproject.toml, Cargo.toml — Tier 1 keeps this cheap; just note presence.
    return { text: `(${manifest.path} present — full dependency parse deferred to a later tier)`, mainEntry: null, startScript: null };
  } catch (e) {
    return { text: `(couldn't parse ${manifest.path}: ${e.message})`, mainEntry: null, startScript: null };
  }
}

/**
 * Manifest-first, language-aware entry file detection.
 * 1. Look at the manifest for an explicit entry (package.json "main", "scripts.start").
 * 2. Fall back to filename pattern matching ONLY for languages/cases the manifest didn't resolve.
 * Every candidate returned here still has to clear the size cap before full inclusion —
 * that check happens in classifyEntryFiles, not here.
 */
export function detectEntryFileCandidates(filteredPaths, manifestSummary) {
  const candidates = new Set();

  if (manifestSummary) {
    if (manifestSummary.mainEntry) {
      candidates.add(normalizeRelPath(manifestSummary.mainEntry));
    }
    if (manifestSummary.startScript) {
      // crude but effective: pull the first path-looking token out of the start script
      const match = manifestSummary.startScript.match(/([./\w-]+\.(js|ts|py|go))/);
      if (match) candidates.add(normalizeRelPath(match[1]));
    }
  }

  // Fallback pattern matching — only adds paths the manifest didn't already give us.
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

/** Apply the size cap. Returns { included: [], skeletonized: [] } — no exceptions by name. */
export function classifyEntryFiles(candidates, filesByPath, contentByPath) {
  const included = [];
  const skeletonized = [];

  for (const path of candidates) {
    const content = contentByPath[path];
    if (content == null) continue; // fetch failed or wasn't attempted — treat as unavailable, not auto-included

    const lineCount = content.split("\n").length;
    if (lineCount <= ENTRY_SIZE_CAP_LINES) {
      included.push({ path, lineCount, content });
    } else {
      skeletonized.push({ path, lineCount });
    }
  }
  return { included, skeletonized };
}

export function estimateTokens(text) {
  // chars/4 heuristic, as specified. Rough but consistent across the tool.
  return Math.ceil(text.length / 4);
}
