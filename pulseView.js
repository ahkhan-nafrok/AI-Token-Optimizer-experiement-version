// pulseView.js
// Tab 1 — Pulse. Rolling last-12-months contribution calendar + current
// streak. Requires a connected GitHub token (GraphQL has no unauthenticated
// tier), read through the vault — never plaintext.
import { ghGraphQL } from "./lib/github.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { getToken } from "./lib/tokenVault.js";
import {
  getRolling12MonthRange,
  CONTRIBUTION_QUERY,
  parseContributionCalendar,
  buildContributionGrid,
  isContributionCacheStale,
  calculateCurrentStreak,
} from "./lib/pulse.js";

const CACHE_KEY = "ghContributionCache";

export function initPulseView() {
  const tokenPrompt = document.getElementById("pulse-token-prompt");
  const gridEl = document.getElementById("pulse-calendar-grid");
  const streakEl = document.getElementById("pulse-streak");
  const streakNoteEl = document.getElementById("pulse-streak-note");
  const statusEl = document.getElementById("pulse-status");
  const refreshBtn = document.getElementById("pulse-refresh-btn");

  function setStatus(msg, isError = false) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
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
  }

  function renderStreak(dayMap) {
    const { streak, todayPending } = calculateCurrentStreak(dayMap);
    streakEl.textContent = `${streak} day${streak === 1 ? "" : "s"}`;
    streakNoteEl.textContent = todayPending
      ? "Today isn't logged yet — streak holds until the day ends."
      : "";
  }

  /**
   * forceRefresh=true means the user clicked refresh. Even without a forced
   * refresh, a cache from a previous UTC day is always treated as stale and
   * refetched automatically on open — the rolling window shifts daily, so
   * "today" needs to exist in the data, not just "nothing changed."
   */
  async function load(forceRefresh = false) {
    const token = await getToken(chromeStorageAdapter);
    if (!token) {
      tokenPrompt.hidden = false;
      gridEl.hidden = true;
      streakEl.parentElement.hidden = true;
      setStatus("");
      return;
    }
    tokenPrompt.hidden = true;
    gridEl.hidden = false;
    streakEl.parentElement.hidden = false;

    const stored = await chromeStorageAdapter.get([CACHE_KEY]);
    const cache = stored[CACHE_KEY] || null;
    const stale = isContributionCacheStale(cache);

    if (!forceRefresh && !stale) {
      renderGrid(buildGridFromCache(cache));
      renderStreak(cache.dayMap);
      setStatus("");
      return;
    }

    setStatus("Fetching contributions...");
    refreshBtn.disabled = true;
    try {
      const range = getRolling12MonthRange();
      const data = await ghGraphQL(CONTRIBUTION_QUERY, { from: range.from, to: range.to }, token);
      const dayMap = parseContributionCalendar(data);
      const grid = buildContributionGrid(data);
      await chromeStorageAdapter.set({
        [CACHE_KEY]: { asOfDateKey: range.asOfDateKey, dayMap, grid, fetchedAt: new Date().toISOString() },
      });
      renderGrid(grid);
      renderStreak(dayMap);
      setStatus("");
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener("click", () => load(true));

  load(false);
}

function buildGridFromCache(cache) {
  // Cached builds already stored the pre-computed grid; older cache entries
  // (pre-this-field) fall back to an empty grid rather than crashing.
  return Array.isArray(cache.grid) ? cache.grid : [];
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}