// projectsView.js
// Project Knowledge Manager — pure GitHub repo tracker, plus two account-level
// "GitHub Overview" widgets (Contribution Calendar, Recently Pushed). No
// claude.ai integration, no push/diff flow. "Check for Updates" is a single
// lightweight GitHub call (lib/github.js#getLatestCommit), not a Tier 1 build.
import { getLatestCommit, parseRepoInput, getContributionCalendar, getRecentRepos } from "./lib/github.js";
import { createProjectStore } from "./lib/projectStore.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import {
  CALENDAR_CACHE_KEY,
  RECENT_REPOS_CACHE_KEY,
  RECENT_REPOS_COUNT,
  RECENT_REPOS_FETCH_COUNT,
  getUTCMonthRange,
  isCalendarStale,
  normalizeCalendarWeeks,
  rankRecentRepos,
} from "./lib/githubOverview.js";

const store = createProjectStore(chromeStorageAdapter);

let activeProjectId = null;

// Inline icon markup — swapped in for the old ★ / ☆ / ✕ text glyphs so
// rendering is crisp and consistent across OS emoji fonts instead of
// relying on the system's Unicode glyph rendering. fill/stroke use
// currentColor so existing CSS color rules (.is-pinned, :hover, etc.)
// keep working exactly as before — no CSS class logic changed.
// Bookmark shape reads more clearly as "pin to top" than a star did.
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

  // GitHub Overview widgets — account-level, always visible regardless of
  // whether a project detail card is open.
  const calendarBody = document.getElementById("gh-calendar-body");
  const calendarRefreshBtn = document.getElementById("gh-calendar-refresh-btn");
  const recentBody = document.getElementById("gh-recent-body");
  const recentRefreshBtn = document.getElementById("gh-recent-refresh-btn");

  function setStatus(el, msg, isError = false) {
    el.hidden = !msg;
    el.textContent = msg;
    el.classList.toggle("error", isError);
  }

  /** The ONE place projectsView.js reads the GitHub token. Reads fresh from
   * storage every time (never caches it in a module-level variable) so it
   * always reflects whatever skeletonizerView.js most recently wrote to the
   * same `ghToken` key — shared storage, not shared logic, per the existing
   * architecture rule. */
  async function getStoredToken() {
    const data = await chromeStorageAdapter.get(["ghToken"]);
    const token = (data.ghToken || "").trim();
    return token || null;
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
   * itself no-ops if the sha hasn't changed). Now reads the real stored
   * token instead of hardcoding null, so private/rate-limited repos work
   * and this tool benefits from the same 5,000/hr bump Skeletonizer gets.
   */
  async function checkForUpdates(id) {
    const p = await store.get(id);
    if (!p) return;
    const { owner, repo } = parseRepoInput(p.repo);
    const token = await getStoredToken();
    const latest = await getLatestCommit(owner, repo, token);
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

  // ===========================================================================
  // GitHub Overview: Contribution Calendar
  // ===========================================================================

  function renderTokenPrompt(container) {
    container.innerHTML = `<p class="hint gh-token-prompt">Add a token to see this.</p>`;
  }

  function renderCalendarGrid(cache) {
    const normalized = normalizeCalendarWeeks(cache.weeks, cache.monthKey);
    const grid = normalized
      .map(
        (week) =>
          `<div class="gh-calendar-week">${week.contributionDays
            .map((day) => {
              const cls = !day.inMonth ? "is-outside" : day.contributed ? "is-contributed" : "is-empty";
              return `<div class="gh-calendar-day ${cls}" title="${escapeHtml(day.date)}"></div>`;
            })
            .join("")}</div>`
      )
      .join("");
    calendarBody.innerHTML = `<div class="gh-calendar-grid">${grid}</div>`;
  }

  async function fetchAndCacheCalendar(token) {
    const { from, to, monthKey } = getUTCMonthRange();
    const weeks = await getContributionCalendar(token, from, to);
    const cache = { monthKey, weeks };
    await chromeStorageAdapter.set({ [CALENDAR_CACHE_KEY]: cache });
    return cache;
  }

  /**
   * Render whatever's cached. Only reaches the network automatically when
   * the cached month has rolled over (a correctness issue, not a "did the
   * data change" question) — otherwise this is manual-refresh-only, same as
   * Recently Pushed, so opening the Projects tab never silently burns a
   * rate-limit call.
   */
  async function renderCalendar({ forceRefresh = false } = {}) {
    const token = await getStoredToken();
    if (!token) {
      renderTokenPrompt(calendarBody);
      return;
    }

    const cacheData = await chromeStorageAdapter.get([CALENDAR_CACHE_KEY]);
    let cache = cacheData[CALENDAR_CACHE_KEY] || null;

    if (forceRefresh || isCalendarStale(cache)) {
      try {
        cache = await fetchAndCacheCalendar(token);
      } catch (e) {
        calendarBody.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
        return;
      }
    }
    renderCalendarGrid(cache);
  }

  calendarRefreshBtn.addEventListener("click", async () => {
    calendarRefreshBtn.disabled = true;
    calendarBody.innerHTML = `<p class="hint">Loading...</p>`;
    try {
      await renderCalendar({ forceRefresh: true });
    } finally {
      calendarRefreshBtn.disabled = false;
    }
  });

  // ===========================================================================
  // GitHub Overview: Recently Pushed
  // ===========================================================================

  function renderRecentList(repos) {
    if (!repos.length) {
      recentBody.innerHTML = `<p class="hint">No repos found on this account.</p>`;
      return;
    }
    recentBody.innerHTML = `<div class="gh-recent-list">${repos
      .map(
        (r) => `
        <div class="gh-recent-item">
          <div class="gh-recent-name">${escapeHtml(r.full_name)}</div>
          <div class="gh-recent-meta">Active ${timeAgo(r.activityAt)}</div>
        </div>`
      )
      .join("")}</div>`;
  }

  async function fetchAndCacheRecentRepos(token) {
    const raw = await getRecentRepos(token, RECENT_REPOS_FETCH_COUNT);
    const ranked = rankRecentRepos(raw, RECENT_REPOS_COUNT);
    await chromeStorageAdapter.set({
      [RECENT_REPOS_CACHE_KEY]: { fetchedAt: new Date().toISOString(), repos: ranked },
    });
    return ranked;
  }

  /** Manual refresh only — never auto-refetches on tab open, so this never
   * silently burns a rate-limit call just from opening the Projects tab. */
  async function renderRecentlyPushed({ forceRefresh = false } = {}) {
    const token = await getStoredToken();
    if (!token) {
      renderTokenPrompt(recentBody);
      return;
    }

    if (forceRefresh) {
      try {
        const ranked = await fetchAndCacheRecentRepos(token);
        renderRecentList(ranked);
      } catch (e) {
        recentBody.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
      }
      return;
    }

    const cacheData = await chromeStorageAdapter.get([RECENT_REPOS_CACHE_KEY]);
    const cached = cacheData[RECENT_REPOS_CACHE_KEY];
    if (cached && Array.isArray(cached.repos)) {
      renderRecentList(cached.repos);
      return;
    }

    // No cache at all yet (fresh install / never refreshed) — manual-only
    // means manual-only, including the very first load. No network call
    // happens until the person clicks Refresh themselves.
    recentBody.innerHTML = `<p class="hint">Click Refresh to load your recently pushed repos.</p>`;
  }

  recentRefreshBtn.addEventListener("click", async () => {
    recentRefreshBtn.disabled = true;
    recentBody.innerHTML = `<p class="hint">Loading...</p>`;
    try {
      await renderRecentlyPushed({ forceRefresh: true });
    } finally {
      recentRefreshBtn.disabled = false;
    }
  });

  renderList();
  renderCalendar();
  renderRecentlyPushed();
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