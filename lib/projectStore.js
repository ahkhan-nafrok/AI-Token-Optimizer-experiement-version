const STORAGE_KEY = "projects";
export const MAX_PINNED = 4;
export const MAX_HISTORY = 6;

function emptyProject(name, repo) {
  return {
    name,
    repo,
    lastCheckedAt: null,
    commitHistory: [],
    pinned: false,
  };
}

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

  async function updateLastChecked(id) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);
    projects[id] = { ...existing, lastCheckedAt: new Date().toISOString() };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  async function addCommitHistoryEntry(id, { sha, commitDate }) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);

    const history = existing.commitHistory || [];
    if (history.length && history[0].sha === sha) {
      return { id, ...withDefaults(existing) };
    }

    const newHistory = [{ sha, commitDate: commitDate || null }, ...history].slice(0, MAX_HISTORY);
    projects[id] = { ...existing, commitHistory: newHistory };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

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