const STORAGE_KEY = "projects";
export const MAX_PINNED = 4;
export const MAX_HISTORY = 6;

function emptyProject(name, repo) {
  return {
    name,
    repo,
    // Overwritten unconditionally every time "Check for Updates" runs,
    // regardless of whether that check found a new commit or not.
    lastCheckedAt: null,
    // Up to MAX_HISTORY entries, newest first: { sha, commitDate }.
    // Only appended to when the latest commit's sha differs from
    // commitHistory[0].sha — a real dedup, not a timestamp heuristic.
    commitHistory: [],
    // Max MAX_PINNED projects can be pinned; pinned projects always sort
    // above unpinned ones in the list, ordered by commit recency among themselves.
    pinned: false,
  };
}

/** Applies migration-safe defaults for fields added after some projects were
 * already stored, so legacy data never crashes and always reads sanely.
 * `lastCommitAt` is a derived convenience field — never stored redundantly —
 * so callers that already sort/render on `lastCommitAt` don't need to change. */
function withDefaults(p) {
  const commitHistory = p.commitHistory || [];
  return {
    ...p,
    commitHistory,
    lastCheckedAt: p.lastCheckedAt || null,
    pinned: !!p.pinned,
    lastCommitAt: commitHistory[0]?.commitDate ?? null,
  };
}

export function createProjectStore(adapter) {
  async function getAll() {
    const data = await adapter.get([STORAGE_KEY]);
    return data[STORAGE_KEY] || {};
  }

  async function saveAll(projects) {
    await adapter.set({ [STORAGE_KEY]: projects });
  }

  async function list() {
    const projects = await getAll();
    return Object.entries(projects).map(([id, p]) => ({ id, ...withDefaults(p) }));
  }

  async function get(id) {
    const projects = await getAll();
    return projects[id] ? { id, ...withDefaults(projects[id]) } : null;
  }

  async function create(id, name, repo) {
    const projects = await getAll();
    if (projects[id]) throw new Error(`Project id "${id}" already exists.`);
    projects[id] = emptyProject(name, repo);
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  async function remove(id) {
    const projects = await getAll();
    delete projects[id];
    await saveAll(projects);
  }

  /** Always fires, regardless of outcome — this is the "Last checked" fact,
   * separate from whether a new commit was actually found. */
  async function updateLastChecked(id) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);
    projects[id] = { ...existing, lastCheckedAt: new Date().toISOString() };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  /**
   * Conditionally appends a new commit-history entry: if `sha` matches the
   * most recent stored entry, this is a no-op (the repo hasn't moved).
   * Otherwise unshifts the new entry and caps the list at MAX_HISTORY,
   * dropping the oldest — a strict FIFO, never more than MAX_HISTORY retained.
   */
  async function addCommitHistoryEntry(id, { sha, commitDate }) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);

    const history = existing.commitHistory || [];
    if (history.length && history[0].sha === sha) {
      return { id, ...withDefaults(existing) }; // unchanged — no-op
    }

    const newHistory = [{ sha, commitDate: commitDate || null }, ...history].slice(0, MAX_HISTORY);
    projects[id] = { ...existing, commitHistory: newHistory };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  /**
   * Pin/unpin a project. Pinning is capped at MAX_PINNED — attempting to pin
   * a 5th project throws rather than silently allowing it or silently
   * bumping another project out. Re-pinning an already-pinned project is a
   * no-op that never counts against the cap.
   */
  async function setPinned(id, pinned) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);

    if (pinned && !existing.pinned) {
      const pinnedCount = Object.values(projects).filter((p) => p.pinned).length;
      if (pinnedCount >= MAX_PINNED) {
        throw new Error(`You can pin up to ${MAX_PINNED} projects. Unpin one first.`);
      }
    }

    projects[id] = { ...existing, pinned: !!pinned };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  return { list, get, create, remove, updateLastChecked, addCommitHistoryEntry, setPinned };
}