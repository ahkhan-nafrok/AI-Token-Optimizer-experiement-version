// lib/build.js
import { getRepoMeta, getTree, getReadme, getFileContent, parseRepoInput } from "./github.js";
import {
  filterTree,
  buildFileTreeText,
  condenseReadme,
  findManifestFiles,
  summarizeManifest,
  assembleManifestSection,
  detectEntryFileCandidates,
  detectManifestJsonEntryPoints,
  extractHtmlScriptRefs,
  classifyEntryFiles,
  planContentFetches,
  shouldSkipFetchForSize,
  extractImports,
  estimateTokens,
  ENTRY_SIZE_CAP_LINES,
} from "./skeletonizer.js";

/**
 * @param {string} repoInput  "owner/repo" or a github.com URL
 * @param {string|null} token  optional GitHub PAT
 * @param {(msg: string) => void} onProgress  status callback for the popup UI
 * @param {object} cache  optional { [path]: { sha, content } } from a previous
 *   build (manifests + entry files only — README is always freshly fetched).
 */
/** Shared fetch-or-reuse helper for one-off paths (manifest.json, a referenced
 * HTML entry) discovered outside the main entry-candidate batch. Populates
 * `newCache` exactly like the main fetch loops so later planContentFetches
 * calls correctly recognize this content as already-known. */
async function fetchOrReuse(path, owner, repo, token, keptByPath, cache, newCache) {
  const { toFetch, reused } = planContentFetches([path], keptByPath, cache);
  if (reused.length) {
    newCache[path] = { sha: reused[0].sha, content: reused[0].content };
    return reused[0].content;
  }
  if (!toFetch.length) return null;
  try {
    const content = await getFileContent(owner, repo, path, token);
    const sha = keptByPath[path] ? keptByPath[path].sha : null;
    if (sha) newCache[path] = { sha, content };
    return content;
  } catch (e) {
    console.warn(`Couldn't fetch ${path}: ${e.message}`);
    return null;
  }
}

export async function buildTier1(repoInput, token, onProgress = () => {}, cache = {}) {
  const { owner, repo } = parseRepoInput(repoInput);

  onProgress(`Fetching ${owner}/${repo} metadata...`);
  const meta = await getRepoMeta(owner, repo, token);
  const branch = meta.default_branch;

  onProgress("Fetching file tree...");
  const rawTree = await getTree(owner, repo, branch, token);
  const { kept, trimmed } = filterTree(rawTree);
  const filteredPathSet = new Set(kept.map((f) => f.path));
  const keptByPath = Object.fromEntries(kept.map((f) => [f.path, f]));

  onProgress("Fetching README...");
  const readmeRaw = await getReadme(owner, repo, token);
  const readme = condenseReadme(readmeRaw);

  onProgress("Discovering manifests...");
  const manifestCandidates = findManifestFiles(filteredPathSet);
  const newCache = {};
  let manifestsReusedCount = 0;
  let manifestsFetchedCount = 0;
  const manifestSummaries = [];

  if (manifestCandidates.length) {
    const manifestPaths = manifestCandidates.map((m) => m.path);
    const { toFetch: manifestsToFetch, reused: manifestsReused } = planContentFetches(
      manifestPaths,
      keptByPath,
      cache
    );

    const contentByManifestPath = {};
    for (const r of manifestsReused) {
      contentByManifestPath[r.path] = r.content;
      newCache[r.path] = { sha: r.sha, content: r.content };
      manifestsReusedCount++;
    }
    for (const path of manifestsToFetch) {
      try {
        const content = await getFileContent(owner, repo, path, token);
        contentByManifestPath[path] = content;
        const sha = keptByPath[path] ? keptByPath[path].sha : null;
        if (sha) newCache[path] = { sha, content };
        manifestsFetchedCount++;
      } catch (e) {
        contentByManifestPath[path] = null;
        console.warn(`Couldn't fetch manifest ${path}: ${e.message}`);
      }
    }

    for (const m of manifestCandidates) {
      const content = contentByManifestPath[m.path];
      if (content == null) continue;
      const dir = m.path.includes("/") ? m.path.slice(0, m.path.lastIndexOf("/")) : "";
      const summary = summarizeManifest(m, content);
      manifestSummaries.push({ ...summary, path: m.path, dir, lang: m.lang });
    }
  }

  const manifestText = assembleManifestSection(manifestSummaries);
  const isMonorepo = manifestCandidates.length > 1;

  // Platform manifest (e.g. Chrome/Firefox extension manifest.json) — a
  // DIFFERENT concept from the language manifests above. When present, it
  // names real entry points directly (popup, options, background, content
  // scripts), which is more reliable than any filename guess. If a named
  // entry is an HTML file, follow its <script src> references too, so
  // "popup.html loads popup.js" isn't lost at the HTML shell.
  onProgress("Checking for a platform manifest (manifest.json)...");
  let platformEntryPaths = [];
  let extensionPlatformInfo = null;
  if (filteredPathSet.has("manifest.json")) {
    const manifestJsonContent = await fetchOrReuse("manifest.json", owner, repo, token, keptByPath, cache, newCache);
    if (manifestJsonContent) {
      const { isExtensionManifest, manifestVersion, entries } = detectManifestJsonEntryPoints(manifestJsonContent);
      if (isExtensionManifest) {
        extensionPlatformInfo = { manifestVersion };
        platformEntryPaths = entries.filter((p) => filteredPathSet.has(p));

        for (const htmlPath of platformEntryPaths.filter((p) => p.endsWith(".html"))) {
          const htmlContent = await fetchOrReuse(htmlPath, owner, repo, token, keptByPath, cache, newCache);
          if (htmlContent) {
            const dir = htmlPath.includes("/") ? htmlPath.slice(0, htmlPath.lastIndexOf("/")) : "";
            const refs = extractHtmlScriptRefs(htmlContent, dir).filter((p) => filteredPathSet.has(p));
            platformEntryPaths.push(...refs);
          }
        }
        platformEntryPaths = [...new Set(platformEntryPaths)];
      }
    }
  }

  onProgress("Detecting entry files...");
  const candidates = [...new Set([...detectEntryFileCandidates(filteredPathSet, manifestSummaries), ...platformEntryPaths])];

  // Anything already fetched during the platform-manifest phase above is in
  // newCache with a correct sha — merging it into the cache used here means
  // planContentFetches recognizes it as already-known and won't refetch it.
  const { toFetch, reused } = planContentFetches(candidates, keptByPath, { ...cache, ...newCache });

  // Pre-fetch size guard: split toFetch into "actually fetch" vs "skip, too
  // big" using GitHub's tree `size` field BEFORE any network call — never
  // download a huge file just to discard it after the fact.
  const sizeGuardSkipped = [];
  const actuallyToFetch = [];
  for (const path of toFetch) {
    if (shouldSkipFetchForSize(path, keptByPath)) sizeGuardSkipped.push(path);
    else actuallyToFetch.push(path);
  }

  onProgress(
    candidates.length
      ? `${reused.length} entry file(s) unchanged (reused), fetching ${actuallyToFetch.length} changed/new` +
          (sizeGuardSkipped.length ? `, ${sizeGuardSkipped.length} skipped (too large to fetch)...` : "...")
      : "No entry files detected."
  );

  const contentByPath = {};
  for (const r of reused) {
    contentByPath[r.path] = r.content;
    newCache[r.path] = { sha: r.sha, content: r.content };
  }
  for (const path of actuallyToFetch) {
    try {
      const content = await getFileContent(owner, repo, path, token);
      contentByPath[path] = content;
      const sha = keptByPath[path] ? keptByPath[path].sha : null;
      if (sha) newCache[path] = { sha, content };
    } catch (e) {
      contentByPath[path] = null;
      console.warn(`Couldn't fetch candidate entry file ${path}: ${e.message}`);
    }
  }
  // Size-guard-skipped paths are intentionally left OUT of contentByPath
  // entirely (not even a null entry) — classifyEntryFiles distinguishes
  // "never attempted, too big" from "attempted, failed" using keptByPath.

  const { included, skeletonized, failed } = classifyEntryFiles(candidates, kept, contentByPath, keptByPath);

  onProgress("Mapping relationships between files...");
  const relationships = [];
  for (const f of included) {
    const imports = extractImports(f.content, f.path);
    if (imports.length) relationships.push({ path: f.path, imports });
  }

  onProgress("Assembling output...");
  const fileTreeText = buildFileTreeText(kept);
  const markdown = assembleMarkdown({
    owner,
    repo,
    description: meta.description,
    language: meta.language,
    readme,
    fileTreeText,
    manifestText,
    isMonorepo,
    extensionPlatformInfo,
    included,
    skeletonized,
    failed,
    relationships,
  });

  const tokenEstimate = estimateTokens(markdown);
  const trimmedNote = `Trimmed ${trimmed.dirs + trimmed.files} path(s) from tree (node_modules/dist/lockfiles/binaries excluded).`;

  return {
    markdown,
    tokenEstimate,
    trimmedNote,
    fileCache: newCache,
    cacheStats: {
      reused: reused.length + manifestsReusedCount,
      fetched: actuallyToFetch.length + manifestsFetchedCount,
      sizeGuardSkipped: sizeGuardSkipped.length,
    },
    entryFiles: {
      included: included.map((f) => ({ path: f.path, lineCount: f.lineCount })),
      skeletonized,
      failed,
      sizeCapLines: ENTRY_SIZE_CAP_LINES,
    },
    relationships,
    stats: {
      totalFilesInTree: rawTree.length,
      keptFiles: kept.length,
      isMonorepo,
      manifestCount: manifestCandidates.length,
      extensionPlatformInfo,
    },
    // Piggybacks on the repo-meta call already made above — zero extra network
    // cost. `pushed_at` is GitHub's own "last time this repo had a push"
    // timestamp. NOTE: the Project Knowledge Manager (Module 2) no longer
    // uses this field — it now calls lib/github.js's getLatestCommit()
    // directly and independently for a real per-commit SHA, decoupled from
    // this Tier 1 build entirely. This field is kept here only because
    // Skeletonizer's own build output still reports it for informational
    // purposes.
    repoMeta: {
      pushedAt: meta.pushed_at || null,
      defaultBranch: branch,
    },
  };
}

function assembleMarkdown({
  owner,
  repo,
  description,
  language,
  readme,
  fileTreeText,
  manifestText,
  isMonorepo,
  extensionPlatformInfo,
  included,
  skeletonized,
  failed,
  relationships,
}) {
  const entrySection = included.length
    ? included.map((f) => `### ${f.path} (${f.lineCount} lines, full)\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
    : "(none under the size cap — all detected entry files were skeletonized; see note below)";

  const skeletonBlocks = skeletonized.map((f) => {
    if (f.skippedFetch) {
      return `**${f.path}** — ~${f.estimatedLineCount.toLocaleString()} lines (estimated from file size; never fetched — too large to be worth downloading just to skeletonize).`;
    }
    if (f.signatures && f.signatures.length) {
      const sigLines = f.signatures.map((s) => `  L${s.line}: \`${s.signature}\``).join("\n");
      return `**${f.path}** (${f.lineCount} lines, over cap — signatures only):\n${sigLines}`;
    }
    return `**${f.path}** (${f.lineCount} lines, over cap — no signatures recognized for this file type).`;
  });

  const skeletonNote = skeletonBlocks.length
    ? `\n\n> Over the ${ENTRY_SIZE_CAP_LINES}-line cap, not included in full:\n\n${skeletonBlocks.join("\n\n")}`
    : "";

  const failedNote =
    failed && failed.length
      ? `\n\n> Could not fetch (excluded, not silently omitted): ${failed.map((f) => f.path).join(", ")}. Retry "Check for Updates" or inspect these manually if they're important entry points.`
      : "";

  const relationshipsSection = relationships.length
    ? relationships.map((r) => `- \`${r.path}\` imports: ${r.imports.map((i) => `\`${i}\``).join(", ")}`).join("\n")
    : "(no local file-to-file relationships detected among the included entry files)";

  const platformNote = extensionPlatformInfo
    ? `**Platform:** Browser extension (Manifest V${extensionPlatformInfo.manifestVersion || "?"}) — entry points below were resolved from \`manifest.json\`, not guessed from filenames.\n`
    : "";

  return `# Repo: ${owner}/${repo}
${description ? `\n${description}\n` : ""}${language ? `Primary language: ${language}\n` : ""}${platformNote}${isMonorepo ? "**Monorepo** — multiple manifests detected, see Dependencies section.\n" : ""}

## README (condensed)
${readme}

## Structure
\`\`\`
${fileTreeText}
\`\`\`

## Dependencies
${manifestText}

## Entry points (full, under size cap)
${entrySection}${skeletonNote}${failedNote}

## Relationships
${relationshipsSection}
`;
}