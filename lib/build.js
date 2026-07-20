// lib/build.js
import { getRepoMeta, getTree, getReadme, getFileContent, parseRepoInput } from "./github.js";
import {
  filterTree,
  buildFileTreeText,
  condenseReadme,
  findManifestFile,
  summarizeManifest,
  detectEntryFileCandidates,
  classifyEntryFiles,
  planContentFetches,
  estimateTokens,
  ENTRY_SIZE_CAP_LINES,
} from "./skeletonizer.js";

/**
 * @param {string} repoInput  "owner/repo" or a github.com URL
 * @param {string|null} token  optional GitHub PAT
 * @param {(msg: string) => void} onProgress  status callback for the popup UI
 * @param {object} cache  optional { [path]: { sha, content } } from a previous
 *   build (manifest + entry files only — README is always freshly fetched,
 *   it's a single cheap call regardless of repo size). Defaults to {}, which
 *   reproduces the old always-fetch-everything behavior exactly.
 */
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

  onProgress("Reading manifest...");
  const manifestMeta = findManifestFile(filteredPathSet);
  let manifestSummary = null;
  let manifestText = "(no recognized manifest file found)";
  const newCache = {};
  let manifestReusedFlag = false;
  if (manifestMeta) {
    const { reused: manifestReused } = planContentFetches(
      [manifestMeta.path],
      keptByPath,
      cache
    );
    let manifestContent;
    if (manifestReused.length) {
      manifestReusedFlag = true;
      manifestContent = manifestReused[0].content;
      newCache[manifestMeta.path] = { sha: manifestReused[0].sha, content: manifestContent };
    } else {
      manifestContent = await getFileContent(owner, repo, manifestMeta.path, token);
      const sha = keptByPath[manifestMeta.path] ? keptByPath[manifestMeta.path].sha : null;
      if (sha) newCache[manifestMeta.path] = { sha, content: manifestContent };
    }
    manifestSummary = summarizeManifest(manifestMeta, manifestContent);
    manifestText = manifestSummary.text;
  }

  onProgress("Detecting entry files...");
  const candidates = detectEntryFileCandidates(filteredPathSet, manifestSummary);

  const { toFetch, reused } = planContentFetches(candidates, keptByPath, cache);
  onProgress(
    candidates.length
      ? `${reused.length} entry file(s) unchanged (reused), fetching ${toFetch.length} changed/new...`
      : "No entry files detected."
  );

  const contentByPath = {};
  for (const r of reused) {
    contentByPath[r.path] = r.content;
    newCache[r.path] = { sha: r.sha, content: r.content };
  }
  for (const path of toFetch) {
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
  const { included, skeletonized, failed } = classifyEntryFiles(candidates, kept, contentByPath);

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
    included,
    skeletonized,
    failed,
  });

  const tokenEstimate = estimateTokens(markdown);
  const trimmedNote = `Trimmed ${trimmed.dirs + trimmed.files} path(s) from tree (node_modules/dist/lockfiles/binaries excluded).`;

  return {
    markdown,
    tokenEstimate,
    trimmedNote,
    fileCache: newCache,
    cacheStats: {
      reused: reused.length + (manifestReusedFlag ? 1 : 0),
      fetched: toFetch.length + (manifestReusedFlag ? 0 : manifestMeta ? 1 : 0),
    },
    entryFiles: {
      included: included.map((f) => ({ path: f.path, lineCount: f.lineCount })),
      skeletonized,
      failed,
      sizeCapLines: ENTRY_SIZE_CAP_LINES,
    },
    stats: {
      totalFilesInTree: rawTree.length,
      keptFiles: kept.length,
    },
  };
}

function assembleMarkdown({ owner, repo, description, language, readme, fileTreeText, manifestText, included, skeletonized, failed }) {
  const entrySection = included.length
    ? included.map((f) => `### ${f.path} (${f.lineCount} lines, full)\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
    : "(none under the size cap — all detected entry files were skeletonized; see note below)";

  const skeletonNote = skeletonized.length
    ? `\n\n> Skeletonized due to size (over ${ENTRY_SIZE_CAP_LINES} lines), not included in full: ${skeletonized
        .map((f) => `${f.path} (${f.lineCount} lines)`)
        .join(", ")}. Tier 2 will provide signatures for these.`
    : "";

  const failedNote = failed && failed.length
    ? `\n\n> Could not fetch (excluded, not silently omitted): ${failed.map((f) => f.path).join(", ")}. Retry "Check for Updates" or inspect these manually if they're important entry points.`
    : "";

  return `# Repo: ${owner}/${repo}
${description ? `\n${description}\n` : ""}${language ? `Primary language: ${language}\n` : ""}

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
`;
}