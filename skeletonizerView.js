import { buildTier1 } from "./lib/build.js";

export function initSkeletonizerView() {

const repoInput = document.getElementById("repo-input");
const tokenInput = document.getElementById("token-input");
const buildBtn = document.getElementById("build-btn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const tokenCountEl = document.getElementById("token-count");
const trimmedNoteEl = document.getElementById("trimmed-note");
const entryFileNoteEl = document.getElementById("entry-file-note");
const outputEl = document.getElementById("output");
const copyBtn = document.getElementById("copy-btn");

let lastMarkdown = "";

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

buildBtn.addEventListener("click", async () => {
  const repo = repoInput.value.trim();
  if (!repo) {
    setStatus("Enter a repo first.", true);
    return;
  }

  chrome.storage.local.set({ lastRepo: repo });

  buildBtn.disabled = true;
  resultEl.hidden = true;
  setStatus("Starting...");

  try {
    const token = tokenInput.value.trim() || null;
    const result = await buildTier1(repo, token, (msg) => setStatus(msg));

    lastMarkdown = result.markdown;
    outputEl.value = result.markdown;
    tokenCountEl.textContent = `~${result.tokenEstimate.toLocaleString()} tokens`;
    trimmedNoteEl.textContent = result.trimmedNote;
    renderEntryFileNote(result.entryFiles);

    resultEl.hidden = false;
    setStatus(`Done. ${result.stats.keptFiles} of ${result.stats.totalFilesInTree} files kept in tree.`);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    buildBtn.disabled = false;
  }
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