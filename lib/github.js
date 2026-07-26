// lib/github.js
// Thin read-only wrapper around the GitHub REST and GraphQL APIs.
// No writes. No auth required for public REST reads (60 req/hr), optional
// PAT bumps to 5,000/hr. GraphQL calls (contribution calendar) and the
// authenticated /user/repos call REQUIRE a token — GitHub's GraphQL API has
// no unauthenticated mode, and /user/* endpoints are inherently account-scoped.

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

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

  if (res.status === 401) {
    throw new Error("GitHub token was rejected (401 Unauthorized). Check that it's valid and hasn't expired.");
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
      throw new Error(
        `GitHub rate limit hit. Resets at ${resetDate}. Add a personal access token in settings to raise the limit to 5,000/hr.`
      );
    }
    throw new Error("GitHub API error: 403 Forbidden.");
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

/**
 * ---------------------------------------------------------------------------
 * GraphQL support — purely additive. ghFetch/getRepoMeta/getTree/getReadme/
 * getFileContent/getLatestCommit above are completely untouched by this.
 * ---------------------------------------------------------------------------
 */

/**
 * POST a GraphQL query to GitHub's /graphql endpoint. Requires a token —
 * GitHub's GraphQL API has no unauthenticated mode at all, unlike REST.
 * Surfaces GraphQL-level errors (data.errors) as real thrown Errors instead
 * of silently returning partial/null data, since a caller checking
 * `data.viewer.foo` on a malformed response would otherwise crash with a
 * confusing "cannot read property of null" instead of a clear message.
 */
export async function ghGraphQL(query, variables, token) {
  if (!token) {
    throw new Error("A GitHub token is required for this request (GraphQL has no unauthenticated mode).");
  }

  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    throw new Error("GitHub token was rejected (401 Unauthorized). Check that it's valid and hasn't expired.");
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
      throw new Error(`GitHub rate limit hit. Resets at ${resetDate}.`);
    }
    throw new Error("GitHub API error: 403 Forbidden.");
  }
  if (!res.ok) {
    throw new Error(`GitHub GraphQL error: ${res.status} ${res.statusText}`);
  }

  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    throw new Error(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  return payload.data;
}

const CONTRIBUTION_CALENDAR_QUERY = `
  query($from: DateTime!, $to: DateTime!) {
    viewer {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch the authenticated viewer's contribution calendar for an arbitrary
 * date range (ISO datetime strings). Returns the raw `weeks` array exactly
 * as GitHub shapes it — binary thresholding, month-boundary filtering, and
 * grid normalization are deliberately NOT done here (see lib/githubOverview.js)
 * so this stays a thin, testable "get me the facts" call, same philosophy
 * as every other function in this file.
 */
export async function getContributionCalendar(token, from, to) {
  const data = await ghGraphQL(CONTRIBUTION_CALENDAR_QUERY, { from, to }, token);
  return data?.viewer?.contributionsCollection?.contributionCalendar?.weeks || [];
}

/**
 * Whole-account "recently pushed or created" repo list via the authenticated
 * /user/repos endpoint — deliberately NOT scoped to tracked projects, so it
 * can surface repos the user hasn't started tracking at all. Ranking by
 * max(created_at, pushed_at) happens in lib/githubOverview.js, not here —
 * this function's only job is "fetch me the raw candidate list."
 */
export async function getRecentRepos(token, count = 10) {
  if (!token) {
    throw new Error("A GitHub token is required to list your repos (this is an account-scoped endpoint).");
  }
  return ghFetch(`/user/repos?sort=pushed&per_page=${count}`, token);
}

function decodeBase64Content(base64) {
  const clean = base64.replace(/\n/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}