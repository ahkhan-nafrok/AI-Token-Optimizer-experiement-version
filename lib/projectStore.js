const STORAGE_KEY = "projects";
export const DEFAULT_TOKEN_CAP = 200_000;
export const MAX_PINNED = 4;

export function capacityWarning(tokens, cap = DEFAULT_TOKEN_CAP) {
  const pct = tokens / cap;
  if (pct >= 1) {
    return {
      level: "over",
      pct,
      message: `~${tokens.toLocaleString()} tokens exceeds the ~${cap.toLocaleString()} token Project Knowledge ceiling. Trim before pushing.`,
    };
  }
  if (pct >= 0.8) {
    return {
      level: "warn",
      pct,
      message: `At ${(pct * 100).toFixed(0)}% of the ~${cap.toLocaleString()} token ceiling for this project.`,
    };
  }
  return { level: "ok", pct, message: null };
}

function emptyProject(name, repo) {
  return {
    name,
    repo,
    lastPushedMarkdown: null,
    lastPushedTokens: 0,
    lastPushedAt: null,
    history: [],
    fileCache: {},
    // Upstream GitHub staleness signal — independent of lastPushedAt. Filled
    // in whenever "Check for Updates" runs, using the repo's own pushed_at
    // timestamp, regardless of whether the user actually pushes afterward.
    lastCommitAt: null,
    // Max MAX_PINNED projects can be pinned; pinned projects always sort
    // above unpinned ones in the list, ordered by lastCommitAt among themselves.
    pinned: false,
  };
}

/** Applies migration-safe defaults for fields added after some projects were
 * already stored, so legacy data never crashes and always reads sanely. */
function withDefaults(p) {
  return {
    ...p,
    fileCache: p.fileCache || {},
    lastCommitAt: p.lastCommitAt || null,
    pinned: !!p.pinned,
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
    return { id, ...projects[id] };
  }

  async function remove(id) {
    const projects = await getAll();
    delete projects[id];
    await saveAll(projects);
  }

  async function recordPush(id, { markdown, tokens, changeSummary, fileCache }) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);

    const entry = { at: new Date().toISOString(), tokens, changeSummary };
    const history = [entry, ...(existing.history || [])].slice(0, 10);

    projects[id] = {
      ...existing,
      lastPushedMarkdown: markdown,
      lastPushedTokens: tokens,
      lastPushedAt: entry.at,
      history,
      fileCache: fileCache !== undefined ? fileCache : existing.fileCache || {},
    };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  /**
   * Records GitHub's own last-push (last-commit) timestamp for this repo.
   * Called every time "Check for Updates" runs, regardless of whether the
   * user goes on to actually push into Claude's Project Knowledge — this is
   * the real upstream-staleness signal the list is sorted by, and it must
   * stay independent of recordPush.
   */
  async function updateCommitInfo(id, lastCommitAt) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);
    projects[id] = {
      ...existing,
      lastCommitAt: lastCommitAt || existing.lastCommitAt || null,
    };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  /**
   * Pin/unpin a project. Pinning is capped at MAX_PINNED — attempting to pin
   * a 5th project throws rather than silently allowing it or silently
   * bumping another project out.
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

  return { list, get, create, remove, recordPush, updateCommitInfo, setPinned };
}