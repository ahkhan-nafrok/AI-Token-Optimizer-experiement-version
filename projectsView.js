// projectsView.js
// Project Knowledge Manager — pure GitHub repo tracker, PLUS an account-level
// "GitHub Overview" (current-month contribution calendar + recently pushed
// repos). The tracker logic below (create/pin/remove/check-for-updates) is
// UNCHANGED from before. The Overview additions read the same `ghToken` key
// Skeletonizer already writes to chrome.storage.local — shared storage, not
// shared logic — and store their own account-level state under two new,
// separate keys (ghContributionCache, ghRecentRepos), never touching the
// `projects` key or projectStore.js at all.
import { getLatestCommit, parseRepoInput, ghGraphQL, getMyRecentRepos } from "./lib/github.js";
import { createProjectStore } from "./lib/projectStore.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import {
  getCurrentUtcMonthRange,
  CONTRIBUTION_QUERY,
  parseContributionCalendar,
  buildMonthGrid,
  isCalendarCacheStale,
  rankRecentRepos,
} from "./lib/githubOverview.js";

const store = createProjectStore(chromeStorageAdapter);

let activeProjectId = null;

const ICON_PIN =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2a1 1 0 0 0-1 1v11l4.5-2.7L12.5 14V3a1 1 0 0 0-1-1h-7Z" fill="currentColor"/></svg>';
const ICON_X =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

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

/** Reads the same `ghToken` key Skeletonizer already writes to
 * chrome.storage.local — no separate token UI for this tab, no shared logic,
 * just both tools independently reading one storage key. */
async function getStoredToken() {
  const data = await chromeStorageAdapter.get(["ghToken"]);
  return (data.ghToken || "").trim() || null;
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

  // ---- GitHub Overview elements ----
  const calTokenPrompt = document.getElementById("gh-calendar-token-prompt");
  const calGridEl = document.getElementById("gh-calendar-grid");
  const calStatusEl = document.getElementById("gh-calendar-status");
  const calRefreshBtn = document.getElementById("gh-calendar-refresh-btn");

  const recentTokenPrompt = document.getElementById("gh-recent-token-prompt");
  const recentListEl = document.getElementById("gh-recent-list");
  const recentStatusEl = document.getElementById("gh-recent-status");
  const recentRefreshBtn = document.getElementById("gh-recent-refresh-btn");

  function setStatus(el, msg, isError = false) {
    el.hidden = !msg;
    el.textContent = msg;
    el.classList.toggle("error", isError);
  }

  async function renderList() {
    const projects = sortProjectsForList(await store.list());
    listEl.innerHTML = "";
    if (!projects.length) {
      listEl.innerHTML = `<div class="empty-state"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2a1 1 0 0 0-1 1v11l4.5-2.7L12.5 14V3a1 1 0 0 0-1-1h-7Z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg><p class="hint">No projects tracked yet — add one below.</p></div>`;
      return;
    }
    for (const p of projects) {
      const neverChecked = !p.lastCommitAt;
      const row = document.createElement("div");
      row.className = "project-list-item" + (p.pinned ? " is-pinned" : "") + (neverChecked ? " is-pending" : "");
      row.innerHTML = `
        <button class="p-pin ${p.pinned ? "is-pinned" : ""}" title="${p.pinned ? "Unpin" : "Pin to top"}">${ICON_PIN}</button>
        <div class="p-body">
          <div class="p-name">${escapeHtml(p.name)}${neverChecked ? '<span class="badge-pending">not checked yet</span>' : ""}</div>
          <div class="p-meta">${escapeHtml(p.repo)} · ${p.lastCommitAt ? "last commit " + timeAgo(p.lastCommitAt) : "GitHub staleness unknown"}</div>
        </div>
        <button class="p-delete" title="Stop tracking">${ICON_X}</button>
      `;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".p-delete") || e.target.closest(".p-pin")) return;
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

    pdPinBtn.innerHTML = `${ICON_PIN}<span>${p.pinned ? "Pinned" : "Pin"}</span>`;
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

  // ---------------------------------------------------------------------
  // GitHub Overview: contribution calendar (manual refresh + automatic
  // month-rollover refetch) and recently pushed (manual refresh only).
  // ---------------------------------------------------------------------

  function renderCalendarGrid(weeks) {
    calGridEl.innerHTML = weeks
      .map((week) => {
        const cellsHtml = week
          .map((cell) => {
            const stateClass = cell ? (cell.contributed ? "is-active" : "is-empty") : "is-blank";
            const titleAttr = cell ? ` title="${escapeHtml(cell.date)}"` : "";
            return `<div class="gh-cal-cell ${stateClass}"${titleAttr}></div>`;
          })
          .join("");
        return `<div class="gh-cal-col">${cellsHtml}</div>`;
      })
      .join("");
  }

  /**
   * forceRefresh=true means the user clicked the refresh button. Even
   * without a forced refresh, a cache from a previous UTC month is always
   * treated as stale and refetched automatically — the calendar view is a
   * correctness concern (which month is "this month"), not a "did anything
   * change" question that should wait for a manual click.
   */
  async function loadCalendar(forceRefresh = false) {
    const token = await getStoredToken();
    if (!token) {
      calTokenPrompt.hidden = false;
      calGridEl.hidden = true;
      setStatus(calStatusEl, "");
      return;
    }
    calTokenPrompt.hidden = true;
    calGridEl.hidden = false;

    const stored = await chromeStorageAdapter.get(["ghContributionCache"]);
    const cache = stored.ghContributionCache || null;
    const stale = isCalendarCacheStale(cache);

    if (!forceRefresh && !stale) {
      const range = getCurrentUtcMonthRange();
      renderCalendarGrid(buildMonthGrid(cache.dayMap, range));
      setStatus(calStatusEl, "");
      return;
    }

    setStatus(calStatusEl, "Fetching contributions...");
    calRefreshBtn.disabled = true;
    try {
      const range = getCurrentUtcMonthRange();
      const data = await ghGraphQL(CONTRIBUTION_QUERY, { from: range.from, to: range.to }, token);
      const dayMap = parseContributionCalendar(data);
      await chromeStorageAdapter.set({
        ghContributionCache: { monthKey: range.monthKey, dayMap, fetchedAt: new Date().toISOString() },
      });
      renderCalendarGrid(buildMonthGrid(dayMap, range));
      setStatus(calStatusEl, "");
    } catch (e) {
      setStatus(calStatusEl, e.message, true);
    } finally {
      calRefreshBtn.disabled = false;
    }
  }

  function renderRecentList(repos) {
    if (!repos.length) {
      recentListEl.innerHTML = `<p class="hint">No repos found.</p>`;
      return;
    }
    recentListEl.innerHTML = repos
      .map(
        (r) => `
        <div class="gh-recent-item">
          <div class="p-body">
            <div class="p-name">${escapeHtml(r.name)}</div>
            <div class="p-meta">${escapeHtml(r.fullName)} · ${r.effectiveIso ? timeAgo(r.effectiveIso) : "unknown"}</div>
          </div>
        </div>`
      )
      .join("");
  }

  /** Manual-refresh-only: no auto-fetch on tab open, so opening the Projects
   * tab never silently spends a rate-limit call. A cached result (from the
   * last manual refresh) is shown until the button is clicked again. */
  async function loadRecentRepos(forceRefresh = false) {
    const token = await getStoredToken();
    if (!token) {
      recentTokenPrompt.hidden = false;
      recentListEl.hidden = true;
      return;
    }
    recentTokenPrompt.hidden = true;
    recentListEl.hidden = false;

    const stored = await chromeStorageAdapter.get(["ghRecentRepos"]);
    const cache = stored.ghRecentRepos || null;

    if (!forceRefresh && cache) {
      renderRecentList(cache.repos);
      return;
    }
    if (!forceRefresh && !cache) {
      // No cache yet and not an explicit refresh click — nothing to show
      // until the user asks for it, consistent with manual-refresh-only.
      recentListEl.innerHTML = `<p class="hint">Click refresh to load your recently pushed repos.</p>`;
      return;
    }

    setStatus(recentStatusEl, "Fetching recent repos...");
    recentRefreshBtn.disabled = true;
    try {
      const repos = await getMyRecentRepos(token);
      const ranked = rankRecentRepos(repos, 2);
      await chromeStorageAdapter.set({ ghRecentRepos: { repos: ranked, fetchedAt: new Date().toISOString() } });
      renderRecentList(ranked);
      setStatus(recentStatusEl, "");
    } catch (e) {
      setStatus(recentStatusEl, e.message, true);
    } finally {
      recentRefreshBtn.disabled = false;
    }
  }

  calRefreshBtn.addEventListener("click", () => loadCalendar(true));
  recentRefreshBtn.addEventListener("click", () => loadRecentRepos(true));

  renderList();
  loadCalendar(false);
  loadRecentRepos(false);
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
