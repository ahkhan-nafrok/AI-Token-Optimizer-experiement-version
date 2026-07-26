// lib/github.js
// Thin read-only wrapper around the GitHub REST API.
// No writes. No auth required (60 req/hr), optional PAT bumps to 5,000/hr.
//
// Also includes a thin GraphQL wrapper (ghGraphQL) and one additional
// authenticated REST call (getMyRecentRepos), added for the Project
// Knowledge Manager's account-level "GitHub Overview" section (contribution
// calendar + recently pushed). Both are purely additive — every existing
// exported function below is byte-for-byte unchanged.

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

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

/**
 * Lightweight single-call fetch of the latest commit on the repo's default
 * branch (no `sha`/branch param — GitHub defaults to the default branch when
 * it's omitted). Used by the Project Knowledge Manager's "Check for Updates",
 * deliberately decoupled from getTree/getReadme/getFileContent so a check
 * costs exactly one API call instead of a full Tier 1 build.
 */
export async function getLatestCommit(owner, repo, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/commits?per_page=1`, token);
  const commit = Array.isArray(data) ? data[0] : null;
  if (!commit) throw new Error("No commits found for this repo.");
  return {
    sha: commit.sha,
    commitDate: commit.commit?.committer?.date || commit.commit?.author?.date || null,
  };
}

function decodeBase64Content(base64) {
  const clean = base64.replace(/\n/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// GitHub Overview additions (Project Knowledge Manager only) — contribution
// calendar + recently pushed. Additive: nothing above this line is touched.
// ---------------------------------------------------------------------------

/**
 * POST-based GraphQL call, distinct from ghFetch's REST GETs above. GitHub's
 * GraphQL API has no unauthenticated tier at all (unlike REST's 60/hr free
 * tier), so a missing token fails fast with a clear message instead of
 * making a network call that's guaranteed to 401.
 */
export async function ghGraphQL(query, variables, token) {
  if (!token) {
    throw new Error("This needs a GitHub token — add one in the Skeletonizer tab.");
  }

  const res = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub GraphQL error: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error(`GitHub GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

/**
 * The authenticated user's own repos, sorted by GitHub's own pushed-recency,
 * used as the candidate pool for "recently pushed or created". Requires a
 * token — there's no meaningful unauthenticated "whole account" concept
 * without one, and this deliberately uses /user/repos (identity comes from
 * the token) rather than /users/{username}/repos, so no separate username
 * needs to be stored anywhere. Fetches a modest sample (default 20) so the
 * caller's client-side max(created_at, pushed_at) ranking has enough
 * candidates — GitHub's own `sort=pushed` alone would miss a brand-new,
 * never-pushed repo that should still surface as "recently created".
 */
export async function getMyRecentRepos(token, sampleSize = 20) {
  if (!token) {
    throw new Error("This needs a GitHub token — add one in the Skeletonizer tab.");
  }
  const data = await ghFetch(`/user/repos?sort=pushed&per_page=${sampleSize}`, token);
  return Array.isArray(data) ? data : [];
}
