// projectsView.js
// Project Knowledge Manager — pure GitHub repo tracker. No claude.ai
// integration, no push/diff flow. "Check for Updates" is a single
// lightweight GitHub call (lib/github.js#getLatestCommit), not a Tier 1 build.
import { getLatestCommit, parseRepoInput } from "./lib/github.js";
import { createProjectStore } from "./lib/projectStore.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";

const store = createProjectStore(chromeStorageAdapter);

let activeProjectId = null;

/**
 * Order projects for the list view:
 *   1. Pinned projects first (max 4), ordered by commit recency among themselves.
 *   2. Unpinned projects after, also ordered by commit recency.
 * Within either group, a project that has never been checked (no lastCommitAt
 * yet) sorts first in that group — it needs attention first. Pure and
 * exported so it's unit-testable without a DOM.
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
  const pdLastChecked = document.getElementById("pd-last-checked");
  const pdLastCommit = document.getElementById("pd-last-commit");
  const pdPinBtn = document.getElementById("pd-pin-btn");
  const pdRefreshBtn = document.getElementById("pd-refresh-btn");
  const pdStatus = document.getElementById("pd-status");
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
        if (!confirm(`Stop tracking "${p.name}"? This only removes it from this extension — nothing on GitHub is affected.`)) return;
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
    const p = await store.get(id);
    if (!p) return;

    pdName.textContent = p.name;
    pdRepo.textContent = p.repo;

    pdLastChecked.textContent = p.lastCheckedAt
      ? `Last checked: ${timeAgo(p.lastCheckedAt)}`
      : "Last checked: never";

    pdLastCommit.textContent = p.lastCommitAt
      ? `Last GitHub commit: ${timeAgo(p.lastCommitAt)}`
      : "Last GitHub commit: unknown";
    pdLastCommit.className = "last-commit-pill" + (p.lastCommitAt ? "" : " unknown");

    pdPinBtn.textContent = p.pinned ? "★ Pinned" : "☆ Pin";
    pdPinBtn.classList.toggle("is-pinned", !!p.pinned);

    setStatus(pdStatus, "");

    pdHistory.innerHTML = p.commitHistory.length
      ? "<strong>Commit history</strong>" +
        p.commitHistory
          .map(
            (h) =>
              `<div class="history-entry">${escapeHtml(h.sha.slice(0, 7))} — ${
                h.commitDate ? new Date(h.commitDate).toLocaleString() : "unknown date"
              }</div>`
          )
          .join("")
      : `<p class="hint">No commit history yet — click Check for Updates.</p>`;

    detailEl.hidden = false;
  }

  /**
   * Shared check logic used by both the new-project flow and the manual
   * refresh button: one GitHub call for the latest commit, then always
   * updateLastChecked, then conditionally addCommitHistoryEntry (which
   * itself no-ops if the sha hasn't changed).
   */
  async function checkForUpdates(id) {
    const p = await store.get(id);
    if (!p) return;
    const { owner, repo } = parseRepoInput(p.repo);
    const latest = await getLatestCommit(owner, repo, null);
    await store.updateLastChecked(id);
    await store.addCommitHistoryEntry(id, latest);
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

      // Immediately fetch commit #1 so history isn't empty on first open.
      // Non-blocking: if this fails (bad repo name, rate limit), the
      // project still exists — just surface the error inline, no rollback.
      try {
        await checkForUpdates(id);
        await renderList();
        if (activeProjectId === id) await openProject(id);
      } catch (err) {
        setStatus(pdStatus, `Project added, but the first check failed: ${err.message}`, true);
      }
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
    setStatus(pdStatus, "Checking GitHub...");
    pdRefreshBtn.disabled = true;
    try {
      await checkForUpdates(activeProjectId);
      setStatus(pdStatus, "");
      await renderList();
      await openProject(activeProjectId);
    } catch (e) {
      setStatus(pdStatus, e.message, true);
    } finally {
      pdRefreshBtn.disabled = false;
    }
  });

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