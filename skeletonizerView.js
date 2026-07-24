import { buildTier1, renderWithTemplate, TEMPLATES } from "./lib/build.js";

export function initSkeletonizerView() {

const repoInput = document.getElementById("repo-input");
const tokenInput = document.getElementById("token-input");
const buildBtn = document.getElementById("build-btn");
const templateBtn = document.getElementById("template-btn");
const templatePicker = document.getElementById("template-picker");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const tokenCountEl = document.getElementById("token-count");
const trimmedNoteEl = document.getElementById("trimmed-note");
const entryFileNoteEl = document.getElementById("entry-file-note");
const outputEl = document.getElementById("output");
const copyBtn = document.getElementById("copy-btn");

let lastMarkdown = "";
// Kept so "Generate as..." can reuse the same fetched content (SHA-checked,
// same defensive rules as everywhere else in the pipeline) instead of
// re-fetching from GitHub for a repo that was just built.
let lastBuildResult = null;
let lastBuiltRepo = null;

// Restore saved token + last repo input, if any.
chrome.storage.local.get(["ghToken", "lastRepo"], (data) => {
  if (data.ghToken) tokenInput.value = data.ghToken;
  if (data.lastRepo) repoInput.value = data.lastRepo;
});

tokenInput.addEventListener("change", () => {
  chrome.storage.local.set({ ghToken: tokenInput.value.trim() });
});

function setStatus(msg, isError = false) {
  statusEl.hidden = !msg;
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function renderEntryFileNote(entryFiles) {
  const lines = [];
  if (entryFiles.included.length) {
    lines.push(
      `Auto-included in full (under ${entryFiles.sizeCapLines}-line cap): ${entryFiles.included
        .map((f) => `${f.path} (${f.lineCount}L)`)
        .join(", ")}`
    );
  }
  if (entryFiles.skeletonized.length) {
    lines.push(
      `Skeletonized — over the cap, no exception by filename: ${entryFiles.skeletonized
        .map((f) => `${f.path} (${f.lineCount}L)`)
        .join(", ")}`
    );
  }
  if (!lines.length) lines.push("No entry files detected in this repo.");
  entryFileNoteEl.textContent = lines.join("\n");
}

function showOutput(markdown, result) {
  lastMarkdown = markdown;
  outputEl.value = markdown;
  tokenCountEl.textContent = `~${Math.ceil(markdown.length / 4).toLocaleString()} tokens`;
  trimmedNoteEl.textContent = result.trimmedNote;
  renderEntryFileNote(result.entryFiles);
  resultEl.hidden = false;
}

/**
 * Shared by both the Default build and "Generate as..." — reuses
 * lastBuildResult.fileCache when the repo input hasn't changed since the
 * last build, so picking a template right after a default build costs zero
 * extra GitHub calls for unchanged files. If the repo input HAS changed,
 * this is just a normal fresh build (empty cache), same as clicking Build.
 */
async function runBuild() {
  const repo = repoInput.value.trim();
  if (!repo) {
    setStatus("Enter a repo first.", true);
    return null;
  }
  chrome.storage.local.set({ lastRepo: repo });

  const token = tokenInput.value.trim() || null;
  const cache = lastBuiltRepo === repo && lastBuildResult ? lastBuildResult.fileCache : {};
  const result = await buildTier1(repo, token, (msg) => setStatus(msg), cache);

  lastBuildResult = result;
  lastBuiltRepo = repo;
  return result;
}

buildBtn.addEventListener("click", async () => {
  buildBtn.disabled = true;
  templateBtn.disabled = true;
  templatePicker.hidden = true;
  resultEl.hidden = true;
  setStatus("Starting...");

  try {
    const result = await runBuild();
    if (!result) return;
    showOutput(result.markdown, result);
    setStatus(`Done. ${result.stats.keptFiles} of ${result.stats.totalFilesInTree} files kept in tree.`);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    buildBtn.disabled = false;
    templateBtn.disabled = false;
  }
});

templateBtn.addEventListener("click", () => {
  templatePicker.hidden = !templatePicker.hidden;
});

templatePicker.querySelectorAll(".template-option").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const templateId = btn.dataset.template;
    buildBtn.disabled = true;
    templateBtn.disabled = true;
    resultEl.hidden = true;
    setStatus(`Building (${TEMPLATES[templateId].label})...`);

    try {
      const result = await runBuild();
      if (!result) return;
      const templated = renderWithTemplate(result, templateId);
      showOutput(templated, result);
      setStatus(`Done — rendered as ${TEMPLATES[templateId].label}.`);
      templatePicker.hidden = true;
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      buildBtn.disabled = false;
      templateBtn.disabled = false;
    }
  });
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastMarkdown);
    copyBtn.textContent = "Copied ✓";
    setTimeout(() => (copyBtn.textContent = "Copy to Clipboard"), 1500);
  } catch (e) {
    setStatus("Clipboard write failed: " + e.message, true);
  }
});

} // end initSkeletonizerView