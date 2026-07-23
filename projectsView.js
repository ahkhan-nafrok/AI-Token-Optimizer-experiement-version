// projectsView.js
import { buildTier1 } from "./lib/build.js";
import { createProjectStore } from "./lib/projectStore.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { diffMarkdown } from "./lib/diff.js";
import { capacityWarning } from "./lib/projectStore.js";

const store = createProjectStore(chromeStorageAdapter);

let activeProjectId = null;
let pendingBuild = null; // { markdown, tokenEstimate, diff, fileCache, repoMeta } — result of "Check for Updates", awaiting a push choice

/**
 * Order projects for the list view:
 *   1. Pinned projects first (max 4), ordered by commit recency among themselves.
 *   2. Unpinned projects after, also ordered by commit recency.
 * Within either group, a project that has never been checked (no lastCommitAt
 * yet) sorts first in that group — same "needs attention first" idea as the
 * old pending-first behavior, just keyed on real GitHub staleness instead of
 * whether it's been pushed to Claude. Pure and exported so it's unit-testable
 * without a DOM.
 */
export function sortProjectsForList(projects) {
  return [...projects].sort((a, b) => {
    const aPinned = !!a.pinned;
    const bPinned = !!b.pinned;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return compareByCommitRecency(a, b);
  });
}

function compareByCommitRecency(a, b) {
  const aChecked = !!a.lastCommitAt;
  const bChecked = !!b.lastCommitAt;
  if (aChecked !== bChecked) return aChecked ? 1 : -1; // never-checked bubbles to the top of its group
  if (!aChecked) return a.name.localeCompare(b.name);
  return new Date(b.lastCommitAt).getTime() - new Date(a.lastCommitAt).getTime();
}

export function initProjectsView() {
  const listEl = document.getElementById("project-list");
  const newBtn = document.getElementById("new-project-btn");
  const nameInput = document.getElementById("new-project-name");
  const repoInput = document.getElementById("new-project-repo");
  const newForm = document.getElementById("new-project-form");

  const detailEl = document.getElementById("project-detail");
  const pdName = document.getElementById("pd-name");
  const pdRepo = document.getElementById("pd-repo");
  const pdPushStatus = document.getElementById("pd-push-status");
  const pdLastCommit = document.getElementById("pd-last-commit");
  const pdPinBtn = document.getElementById("pd-pin-btn");
  const pdRefreshBtn = document.getElementById("pd-refresh-btn");
  const pdStatus = document.getElementById("pd-status");
  const pdDiff = document.getElementById("pd-diff");
  const pdDiffSummary = document.getElementById("pd-diff-summary");
  const pdCapacityWarning = document.getElementById("pd-capacity-warning");
  const pdCopyBtn = document.getElementById("pd-copy-btn");
  const pdDownloadBtn = document.getElementById("pd-download-btn");
  const pdAutoUploadBtn = document.getElementById("pd-autoupload-btn");
  const pdPushResult = document.getElementById("pd-push-result");
  const pdHistory = document.getElementById("pd-history");

  function setStatus(el, msg, isError = false) {
    el.hidden = !msg;
    el.textContent = msg;
    el.classList.toggle("error", isError);
  }

  async function renderList() {
    const projects = sortProjectsForList(await store.list());
    listEl.innerHTML = "";
    if (!projects.length) {
      listEl.innerHTML = `<p class="hint">No projects tracked yet — add one below.</p>`;
      return;
    }
    for (const p of projects) {
      const neverChecked = !p.lastCommitAt;
      const row = document.createElement("div");
      row.className = "project-list-item" + (p.pinned ? " is-pinned" : "") + (neverChecked ? " is-pending" : "");
      row.innerHTML = `
        <button class="p-pin ${p.pinned ? "is-pinned" : ""}" title="${p.pinned ? "Unpin" : "Pin to top"}">${p.pinned ? "★" : "☆"}</button>
        <div class="p-body">
          <div class="p-name">${escapeHtml(p.name)}${neverChecked ? '<span class="badge-pending">not checked yet</span>' : ""}</div>
          <div class="p-meta">${escapeHtml(p.repo)} · ${p.lastCommitAt ? "last commit " + timeAgo(p.lastCommitAt) : "GitHub staleness unknown"}</div>
        </div>
        <button class="p-delete" title="Stop tracking">✕</button>
      `;
      row.addEventListener("click", (e) => {
        if (e.target.classList.contains("p-delete") || e.target.classList.contains("p-pin")) return;
        openProject(p.id);
      });
      row.querySelector(".p-pin").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await store.setPinned(p.id, !p.pinned);
          await renderList();
          if (activeProjectId === p.id) await openProject(p.id);
        } catch (err) {
          alert(err.message);
        }
      });
      row.querySelector(".p-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Stop tracking "${p.name}"? This only removes it from this extension, nothing is deleted on claude.ai.`)) return;
        await store.remove(p.id);
        if (activeProjectId === p.id) {
          activeProjectId = null;
          detailEl.hidden = true;
        }
        renderList();
      });
      listEl.appendChild(row);
    }
  }

  async function openProject(id) {
    activeProjectId = id;
    pendingBuild = null;
    const p = await store.get(id);
    if (!p) return;

    pdName.textContent = p.name;
    pdRepo.textContent = p.repo;

    if (p.lastPushedAt) {
      pdPushStatus.textContent = `Pushed to Claude ${timeAgo(p.lastPushedAt)}`;
      pdPushStatus.className = "push-status-pill pushed";
    } else {
      pdPushStatus.textContent = "Not yet pushed — no baseline to diff against";
      pdPushStatus.className = "push-status-pill pending";
    }

    pdLastCommit.textContent = p.lastCommitAt
      ? `Last GitHub commit: ${timeAgo(p.lastCommitAt)}`
      : "Last GitHub commit: unknown — click Check for Updates";
    pdLastCommit.className = "last-commit-pill" + (p.lastCommitAt ? "" : " unknown");

    pdPinBtn.textContent = p.pinned ? "★ Pinned" : "☆ Pin";
    pdPinBtn.classList.toggle("is-pinned", !!p.pinned);

    pdDiff.hidden = true;
    pdDiff.classList.remove("needs-baseline");
    pdPushResult.textContent = "";
    setStatus(pdStatus, "");

    pdHistory.innerHTML = p.history.length
      ? "<strong>History</strong>" +
        p.history
          .map((h) => `<div class="history-entry">${new Date(h.at).toLocaleString()} — ${escapeHtml(h.changeSummary)} (~${h.tokens.toLocaleString()} tok)</div>`)
          .join("")
      : `<p class="hint">No pushes recorded yet.</p>`;

    detailEl.hidden = false;
  }

  newBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const repo = repoInput.value.trim();
    if (!name || !repo) {
      alert("Give the project a name and a repo (owner/repo).");
      return;
    }
    const id = slugify(name);
    try {
      await store.create(id, name, repo);
      nameInput.value = "";
      repoInput.value = "";
      newForm.open = false;
      await renderList();
      await openProject(id);
    } catch (e) {
      alert(e.message);
    }
  });

  pdPinBtn.addEventListener("click", async () => {
    if (!activeProjectId) return;
    const p = await store.get(activeProjectId);
    try {
      await store.setPinned(activeProjectId, !p.pinned);
      await renderList();
      await openProject(activeProjectId);
    } catch (e) {
      alert(e.message);
    }
  });

  pdRefreshBtn.addEventListener("click", async () => {
    if (!activeProjectId) return;
    const p = await store.get(activeProjectId);
    pdDiff.hidden = true;
    pdPushResult.textContent = "";
    setStatus(pdStatus, "Building skeleton...");
    pdRefreshBtn.disabled = true;

    try {
      const { markdown, tokenEstimate, fileCache, cacheStats, repoMeta } = await buildTier1(
        p.repo,
        null,
        (msg) => setStatus(pdStatus, msg),
        p.fileCache || {}
      );
      const diff = diffMarkdown(p.lastPushedMarkdown, markdown);
      pendingBuild = { markdown, tokenEstimate, diff, fileCache, repoMeta };

      // Record GitHub's own last-push (commit) timestamp regardless of
      // whether the user goes on to push into Claude — this is the real
      // staleness signal the list sorts by, independent of push behavior.
      if (repoMeta && repoMeta.pushedAt) {
        await store.updateCommitInfo(activeProjectId, repoMeta.pushedAt);
        pdLastCommit.textContent = `Last GitHub commit: ${timeAgo(repoMeta.pushedAt)}`;
        pdLastCommit.className = "last-commit-pill";
      }

      const cacheNote = cacheStats && (cacheStats.reused || cacheStats.fetched)
        ? ` · ${cacheStats.reused} file(s) unchanged (skipped), ${cacheStats.fetched} fetched` +
          (cacheStats.sizeGuardSkipped ? `, ${cacheStats.sizeGuardSkipped} skipped (too large)` : "")
        : "";

      if (diff.isFirstPush) {
        pdDiffSummary.textContent = `No version pushed yet — use one of the options below to set the baseline. Future checks will show what changed. · ~${tokenEstimate.toLocaleString()} tokens total${cacheNote}`;
        pdDiff.classList.add("needs-baseline");
      } else {
        pdDiffSummary.textContent = `${diff.summary} · ~${tokenEstimate.toLocaleString()} tokens total${cacheNote}`;
        pdDiff.classList.remove("needs-baseline");
      }
      const warning = capacityWarning(tokenEstimate);
      if (warning.message) {
        pdCapacityWarning.hidden = false;
        pdCapacityWarning.textContent = warning.message;
      } else {
        pdCapacityWarning.hidden = true;
      }
      pdDiff.hidden = false;
      setStatus(pdStatus, "");
      renderList(); // list order may have changed now that lastCommitAt updated
    } catch (e) {
      setStatus(pdStatus, e.message, true);
    } finally {
      pdRefreshBtn.disabled = false;
    }
  });

  pdCopyBtn.addEventListener("click", async () => {
    if (!pendingBuild) return;
    await navigator.clipboard.writeText(pendingBuild.markdown);
    await confirmPush("Copied to clipboard — paste into this Project's Knowledge panel.");
  });

  pdDownloadBtn.addEventListener("click", async () => {
    if (!pendingBuild || !activeProjectId) return;
    const p = await store.get(activeProjectId);
    const filename = `${slugify(p.name)}-skeleton.md`;
    const blob = new Blob([pendingBuild.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({ url, filename }, () => {
      URL.revokeObjectURL(url);
    });

    await confirmPush(`Downloaded as ${filename} — drag it into Project Knowledge, replacing the old version.`);
  });

  pdAutoUploadBtn.addEventListener("click", async () => {
    if (!pendingBuild || !activeProjectId) return;
    const p = await store.get(activeProjectId);
    const filename = `${slugify(p.name)}-skeleton.md`;

    pdAutoUploadBtn.disabled = true;
    pdPushResult.textContent = "Attempting auto-upload on the active tab...";

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.startsWith("https://claude.ai/")) {
        pdPushResult.textContent = "Active tab isn't claude.ai. Open the target Project there first, then retry.";
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "TOKEN_OPTIMIZER_AUTO_UPLOAD",
        filename,
        content: pendingBuild.markdown,
      });

      pdPushResult.textContent = response?.reason || "No response from the page — try Download instead.";
      if (response?.success) {
        await confirmPush(response.reason, /* skipMessage */ true);
      }
    } catch (e) {
      pdPushResult.textContent = `Auto-upload failed (${e.message}). Use Download or Copy instead — this path is experimental.`;
    } finally {
      pdAutoUploadBtn.disabled = false;
    }
  });

  /** Record the push in storage once the user has actually acted on pendingBuild. */
  async function confirmPush(message, skipMessage = false) {
    if (!pendingBuild || !activeProjectId) return;
    await store.recordPush(activeProjectId, {
      markdown: pendingBuild.markdown,
      tokens: pendingBuild.tokenEstimate,
      changeSummary: pendingBuild.diff.summary,
      fileCache: pendingBuild.fileCache,
    });
    if (!skipMessage) pdPushResult.textContent = message;
    pendingBuild = null;
    await renderList();
    await openProject(activeProjectId);
  }

  renderList();
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}