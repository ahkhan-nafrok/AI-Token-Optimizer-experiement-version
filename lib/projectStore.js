const STORAGE_KEY = "projects";
export const DEFAULT_TOKEN_CAP = 200_000;

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
    return Object.entries(projects).map(([id, p]) => ({ id, ...p, fileCache: p.fileCache || {} }));
  }

  async function get(id) {
    const projects = await getAll();
    return projects[id] ? { id, ...projects[id], fileCache: projects[id].fileCache || {} } : null;
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
      // Omitting fileCache must preserve what was already there, never silently
      // wipe it — a caller that doesn't know about caching shouldn't be able
      // to accidentally erase another caller's cached work.
      fileCache: fileCache !== undefined ? fileCache : existing.fileCache || {},
    };
    await saveAll(projects);
    return { id, ...projects[id] };
  }

  return { list, get, create, remove, recordPush };
}