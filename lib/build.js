// lib/build.js
// Orchestrates Tier 1 build: fetch -> filter -> condense -> detect entry files -> assemble.

import { getRepoMeta, getTree, getReadme, getFileContent, parseRepoInput } from "./github.js";
import {
  filterTree,
  buildFileTreeText,
  condenseReadme,
  findManifestFile,
  summarizeManifest,
  detectEntryFileCandidates,
  classifyEntryFiles,
  estimateTokens,
  ENTRY_SIZE_CAP_LINES,
} from "./skeletonizer.js";

/**
 * @param {string} repoInput  "owner/repo" or a github.com URL
 * @param {string|null} token  optional GitHub PAT
 * @param {(msg: string) => void} onProgress  status callback for the popup UI
 */
export async function buildTier1(repoInput, token, onProgress = () => {}) {
  const { owner, repo } = parseRepoInput(repoInput);

  onProgress(`Fetching ${owner}/${repo} metadata...`);
  const meta = await getRepoMeta(owner, repo, token);
  const branch = meta.default_branch;

  onProgress("Fetching file tree...");
  const rawTree = await getTree(owner, repo, branch, token);
  const { kept, trimmed } = filterTree(rawTree);
  const filteredPathSet = new Set(kept.map((f) => f.path));

  onProgress("Fetching README...");
  const readmeRaw = await getReadme(owner, repo, token);
  const readme = condenseReadme(readmeRaw);

  onProgress("Reading manifest...");
  const manifestMeta = findManifestFile(filteredPathSet);
  let manifestSummary = null;
  let manifestText = "(no recognized manifest file found)";
  if (manifestMeta) {
    const manifestContent = await getFileContent(owner, repo, manifestMeta.path, token);
    manifestSummary = summarizeManifest(manifestMeta, manifestContent);
    manifestText = manifestSummary.text;
  }

  onProgress("Detecting entry files...");
  const candidates = detectEntryFileCandidates(filteredPathSet, manifestSummary);

  onProgress(candidates.length ? `Checking ${candidates.length} entry file(s) against size cap...` : "No entry files detected.");
  const contentByPath = {};
  for (const path of candidates) {
    try {
      contentByPath[path] = await getFileContent(owner, repo, path, token);
    } catch (e) {
      contentByPath[path] = null; // fetch failed — excluded, not silently assumed small
      console.warn(`Couldn't fetch candidate entry file ${path}: ${e.message}`);
    }
  }
  const { included, skeletonized } = classifyEntryFiles(candidates, kept, contentByPath);

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
  });

  const tokenEstimate = estimateTokens(markdown);
  const trimmedNote = `Trimmed ${trimmed.dirs + trimmed.files} path(s) from tree (node_modules/dist/lockfiles/binaries excluded).`;

  return {
    markdown,
    tokenEstimate,
    trimmedNote,
    entryFiles: {
      included: included.map((f) => ({ path: f.path, lineCount: f.lineCount })),
      skeletonized,
      sizeCapLines: ENTRY_SIZE_CAP_LINES,
    },
    stats: {
      totalFilesInTree: rawTree.length,
      keptFiles: kept.length,
    },
  };
}

function assembleMarkdown({ owner, repo, description, language, readme, fileTreeText, manifestText, included, skeletonized }) {
  const entrySection = included.length
    ? included.map((f) => `### ${f.path} (${f.lineCount} lines, full)\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
    : "(none under the size cap — all detected entry files were skeletonized; see note below)";

  const skeletonNote = skeletonized.length
    ? `\n\n> Skeletonized due to size (over ${ENTRY_SIZE_CAP_LINES} lines), not included in full: ${skeletonized
        .map((f) => `${f.path} (${f.lineCount} lines)`)
        .join(", ")}. Tier 2 will provide signatures for these.`
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
${entrySection}${skeletonNote}
`;
}
