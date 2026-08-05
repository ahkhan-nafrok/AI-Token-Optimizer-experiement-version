// pulseView.js
// Tab 1 — Pulse. Rolling last-12-months contribution calendar + current
// streak + this-year total + last-pushed repo. Requires a connected GitHub
// token (GraphQL has no unauthenticated tier), read through the vault —
// never plaintext.
import { ghGraphQL, getMostRecentlyPushedRepo } from "./lib/github.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { getToken } from "./lib/tokenVault.js";
import {
  getRolling12MonthRange,
  CONTRIBUTION_QUERY,
  parseContributionCalendar,
  buildContributionGrid,
  isContributionCacheStale,
  calculateCurrentStreak,
  calculateYearTotal,
} from "./lib/pulse.js";

const CACHE_KEY = "ghContributionCache";
const SUCCESS_STATE_MS = 1600;

export function initPulseView() {
  const tokenPrompt = document.getElementById("pulse-token-prompt");
  const calendarWrap = document.getElementById("pulse-calendar-wrap");
  const gridEl = document.getElementById("pulse-calendar-grid");
  const statsRow = document.getElementById("pulse-stats-row");
  const streakEl = document.getElementById("pulse-streak");
  const streakNoteEl = document.getElementById("pulse-streak-note");
  const yearTotalEl = document.getElementById("pulse-year-total");
  const statusEl = document.getElementById("pulse-status");
  const refreshBtn = document.getElementById("pulse-refresh-btn");
  const updateLabelEl = document.getElementById("pulse-update-btn-label");
  const lastUpdatedEl = document.getElementById("pulse-last-updated");
  const lastPushedEl = document.getElementById("pulse-last-pushed");
  const plpRepoNameEl = document.getElementById("plp-repo-name");
  const plpRepoBadgeEl = document.getElementById("plp-repo-badge");
  const plpRepoDescEl = document.getElementById("plp-repo-desc");
  const plpPushedAtEl = document.getElementById("plp-pushed-at");
  const plpLanguageEl = document.getElementById("plp-language");

  let successTimer = null;

  function setStatus(msg, isError = false) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
  }

  /**
   * idle / loading / success — none of these lean on color per the
   * monochrome design system; the icon shape, spin, and a brief scale
   * pulse carry the state instead. "success" auto-reverts to idle after a
   * short beat so the button doesn't get stuck reading "Updated" forever.
   */
  function setUpdateBtnState(state) {
    clearTimeout(successTimer);
    refreshBtn.classList.remove("is-loading", "is-success");
    if (state === "loading") {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-loading");
      updateLabelEl.textContent = "Updating...";
    } else if (state === "success") {
      refreshBtn.disabled = false;
      refreshBtn.classList.add("is-success");
      updateLabelEl.textContent = "Updated";
      successTimer = setTimeout(() => {
        refreshBtn.classList.remove("is-success");
        updateLabelEl.textContent = "Click to Update";
      }, SUCCESS_STATE_MS);
    } else {
      refreshBtn.disabled = false;
      updateLabelEl.textContent = "Click to Update";
    }
  }

  function renderGrid(weeks) {
    gridEl.innerHTML = weeks
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
    scrollToPresent();
  }

  /** Defaults the calendar to its current-month (rightmost) end rather than
   * opening on the oldest, year-ago end. Runs after layout so scrollWidth
   * reflects the just-rendered grid. */
  function scrollToPresent() {
    requestAnimationFrame(() => {
      calendarWrap.scrollLeft = calendarWrap.scrollWidth;
    });
  }

  function renderStreak(dayMap) {
    const { streak, todayPending } = calculateCurrentStreak(dayMap);
    streakEl.textContent = `${streak} day${streak === 1 ? "" : "s"}`;
    streakNoteEl.textContent = todayPending
      ? "Today isn't logged yet — streak holds until the day ends."
      : "";
  }

  function renderYearTotal(dayMap) {
    yearTotalEl.textContent = String(calculateYearTotal(dayMap));
  }

  function renderLastPushed(repo) {
    if (!repo) {
      lastPushedEl.hidden = true;
      return;
    }
    lastPushedEl.hidden = false;
    plpRepoNameEl.textContent = repo.fullName;
    plpRepoBadgeEl.hidden = !repo.isPrivate;
    plpRepoDescEl.textContent = repo.description || "No description";
    plpPushedAtEl.textContent = repo.pushedAt ? `Pushed ${formatRelativeTime(repo.pushedAt)}` : "";
    plpLanguageEl.textContent = repo.language || "";
  }

  function renderLastUpdated(fetchedAt) {
    if (!fetchedAt) {
      lastUpdatedEl.hidden = true;
      return;
    }
    lastUpdatedEl.hidden = false;
    lastUpdatedEl.textContent = `Updated ${formatRelativeTime(fetchedAt)}`;
  }

  function renderAll(cache) {
    calendarWrap.hidden = false;
    statsRow.hidden = false;
    renderGrid(Array.isArray(cache.grid) ? cache.grid : []);
    renderStreak(cache.dayMap || {});
    renderYearTotal(cache.dayMap || {});
    renderLastPushed(cache.lastPushedRepo || null);
    renderLastUpdated(cache.fetchedAt || null);
  }

  /**
   * forceRefresh=true means the user clicked Update. Even without a forced
   * refresh, a cache from a previous UTC day is always treated as stale and
   * refetched automatically on open — the rolling window shifts daily, so
   * "today" needs to exist in the data, not just "nothing changed." A
   * cache saved before the last-pushed feature existed (missing that field)
   * is also treated as stale, so it gets backfilled on next open rather
   * than permanently hiding that section.
   */
  async function load(forceRefresh = false) {
    const token = await getToken(chromeStorageAdapter);
    if (!token) {
      tokenPrompt.hidden = false;
      calendarWrap.hidden = true;
      statsRow.hidden = true;
      lastPushedEl.hidden = true;
      lastUpdatedEl.hidden = true;
      setStatus("");
      return;
    }
    tokenPrompt.hidden = true;

    const stored = await chromeStorageAdapter.get([CACHE_KEY]);
    const cache = stored[CACHE_KEY] || null;
    const stale = isContributionCacheStale(cache) || (cache && !cache.lastPushedRepo);

    if (!forceRefresh && !stale) {
      renderAll(cache);
      setStatus("");
      return;
    }

    setUpdateBtnState("loading");
    setStatus("Fetching your latest activity...");
    try {
      const range = getRolling12MonthRange();
      // Last-pushed is purely additive/display — its failure must never
      // block the core contribution data from loading, so it's caught
      // independently rather than let Promise.all reject the whole batch.
      const [contribData, lastPushedRepo] = await Promise.all([
        ghGraphQL(CONTRIBUTION_QUERY, { from: range.from, to: range.to }, token),
        getMostRecentlyPushedRepo(token).catch(() => null),
      ]);
      const dayMap = parseContributionCalendar(contribData);
      const grid = buildContributionGrid(contribData);
      const newCache = {
        asOfDateKey: range.asOfDateKey,
        dayMap,
        grid,
        lastPushedRepo,
        fetchedAt: new Date().toISOString(),
      };
      await chromeStorageAdapter.set({ [CACHE_KEY]: newCache });
      renderAll(newCache);
      setStatus("");
      setUpdateBtnState("success");
    } catch (e) {
      setStatus(e.message, true);
      setUpdateBtnState("idle");
    }
  }

  enableDragScroll(calendarWrap);
  refreshBtn.addEventListener("click", () => load(true));

  load(false);
}

/** Click-and-drag / touch-swipe horizontal scroll for the calendar wrap —
 * replaces the native scrollbar entirely (see popup.css: scrollbar hidden,
 * edges fade via mask-image instead). Mouse listeners are bound on
 * `window` for move/up so a drag that leaves the element's bounds doesn't
 * get stuck "down." */
function enableDragScroll(el) {
  let isDown = false;
  let startX = 0;
  let scrollLeftStart = 0;

  function start(x) {
    isDown = true;
    el.classList.add("is-dragging");
    startX = x;
    scrollLeftStart = el.scrollLeft;
  }
  function move(x) {
    if (!isDown) return;
    el.scrollLeft = scrollLeftStart - (x - startX);
  }
  function end() {
    isDown = false;
    el.classList.remove("is-dragging");
  }

  el.addEventListener("mousedown", (e) => {
    start(e.pageX);
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => move(e.pageX));
  window.addEventListener("mouseup", end);

  el.addEventListener("touchstart", (e) => start(e.touches[0].pageX), { passive: true });
  el.addEventListener("touchmove", (e) => move(e.touches[0].pageX), { passive: true });
  el.addEventListener("touchend", end);
}

/** Short relative-time label ("just now", "3h ago", "2d ago", ...) used for
 * both the "Updated ..." caption and the last-pushed repo's timestamp. */
function formatRelativeTime(isoString, now = new Date()) {
  if (!isoString) return "";
  const thenMs = new Date(isoString).getTime();
  const diffMs = now.getTime() - thenMs;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "";

  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}