// lib/github.js
// Thin read-only wrapper around the GitHub REST API.
// No writes. No auth required (60 req/hr), optional PAT bumps to 5,000/hr.

const GITHUB_API = "https://api.github.com";

/** Parse "owner/repo" or a full github.com URL into { owner, repo }. */
export function parseRepoInput(input) {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };

  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };

  throw new Error(
    "Couldn't parse that as a repo. Use 'owner/repo' or a full github.com URL."
  );
}

async function ghFetch(path, token) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}${path}`, { headers });

  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
      throw new Error(
        `GitHub rate limit hit. Resets at ${resetDate}. Add a personal access token in settings to raise the limit to 5,000/hr.`
      );
    }
  }
  if (res.status === 404) {
    throw new Error("Repo, branch, or file not found (404). Check the owner/repo name and that it's public.");
  }
  if (res.status === 429) {
    throw new Error(
      "GitHub is throttling requests right now (secondary rate limit — too many requests too fast). Wait a moment before retrying."
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getRepoMeta(owner, repo, token) {
  return ghFetch(`/repos/${owner}/${repo}`, token);
}

export async function getTree(owner, repo, branch, token) {
  const data = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token
  );
  if (data.truncated) {
    console.warn("GitHub tree response was truncated (repo is very large). Tier 1 map may be incomplete.");
  }
  return data.tree || [];
}

export async function getReadme(owner, repo, token) {
  try {
    const data = await ghFetch(`/repos/${owner}/${repo}/readme`, token);
    return decodeBase64Content(data.content);
  } catch (e) {
    return null; // no README is a valid state, not an error
  }
}

export async function getFileContent(owner, repo, path, token) {
  const data = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    token
  );
  if (Array.isArray(data)) throw new Error(`${path} is a directory, not a file.`);
  if (data.encoding !== "base64") throw new Error(`Unexpected encoding for ${path}: ${data.encoding}`);
  return decodeBase64Content(data.content);
}

function decodeBase64Content(base64) {
  const clean = base64.replace(/\n/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}