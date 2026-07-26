# Token Optimizer — Setup & Test Guide

**This guide describes v0.3.0+ of the extension.** If you've used an earlier
build: Module 2 no longer does diffing, "pushing," or claude.ai auto-upload —
it's a pure GitHub tracker now, plus a new account-level GitHub Overview.
See [What changed since the old push/diff version](#what-changed-since-the-old-pushdiff-version)
at the bottom if you're coming from that earlier flow.

---

## What's in this package

```
token-optimizer-extension/
├── manifest.json           # Manifest V3 config — host_permissions covers api.github.com
│                            # (REST and GraphQL both live under this one host)
├── popup.html/css/js       # UI shell + tab switching
├── skeletonizerView.js     # Module 1 UI logic
├── projectsView.js         # Module 2 UI logic — tracker + GitHub Overview wiring
├── content.js               # NOT currently wired into any button — see note below
├── lib/
│   ├── github.js            # GitHub REST wrapper (read-only) + a GraphQL wrapper (ghGraphQL),
│   │                        # used only by the contribution calendar
│   ├── githubOverview.js    # Pure logic for the GitHub Overview: month-range math, calendar
│   │                        # grid building, cache staleness, recent-repo ranking. No network,
│   │                        # no chrome.storage — fully unit-testable in Node.
│   ├── skeletonizer.js      # Tier 1 compression + entry-file size-cap heuristic
│   ├── build.js              # Orchestrates github.js + skeletonizer.js, plus output templates
│   ├── diff.js               # Section-level markdown diff engine (pure, no deps) —
│   │                        # kept in the codebase but NOT currently called by any UI
│   ├── projectStore.js       # Tracked-project registry logic (pure, no deps)
│   └── storageAdapter.js     # chrome.storage.local wrapped in Promises
├── test/                    # 10 test files, ~108 assertions total — see Part 1
└── icons/                   # Placeholder icons (replace anytime — cosmetic only)
```

**Zero npm dependencies.** No `node_modules`, nothing to `npm install` to
*run the extension*. The extension itself only uses browser-native APIs
(`fetch`, `chrome.storage`, `DataTransfer`), so there's nothing that can go
stale from a dependency update. The only thing you need installed to run the
*tests* is Node.js itself (developed against Node 22; nothing here uses
bleeding-edge syntax, so any reasonably recent version should work).

---

## Part 1 — Run the automated tests (no browser needed)

Every rule described in this guide and in `README.md` — tree filtering,
caching, entry-file classification, pinning, sort order, contribution grid
math, recent-repo ranking — is covered by a test file that mocks GitHub's
network responses. **No live network calls, no rate-limit risk, no GitHub
token needed** to run any of these:

```bash
cd token-optimizer-extension

node test/skeletonizer.test.mjs
node test/skeletonizer.contextupgrade.test.mjs
node test/build.cache.test.mjs
node test/build.templates.test.mjs
node test/module2.test.mjs
node test/integration.test.mjs
node test/sortProjectsForList.test.mjs
node test/projectsView.integration.test.mjs
node test/githubOverview.test.mjs
node test/github.overview.test.mjs
```

Or run all ten in sequence and see a pass/fail summary for each:

```bash
for f in test/*.mjs; do echo "=== $f ==="; node "$f"; echo; done
```

Every file ends with `N passed, 0 failed.` (or `All ... checks passed.` for
the two hand-rolled integration files) when everything's working. There's no
test framework here — every file is a plain `.mjs` script with hand-rolled
`assert` calls, so `node test/<file>.mjs` is always the whole story; nothing
extra to install to run any single one of them in isolation.

**None of these need a real GitHub token or network access** — every GitHub
response (REST and GraphQL) is mocked inside the test file itself.

---

## Part 2 — Load the extension in Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select the `token-optimizer-extension` folder
5. Pin it to your toolbar (puzzle-piece icon → pin) so it's one click away

If Chrome shows a red error badge on the extension card instead of loading
it, click it — it'll tell you exactly which file/line failed. If you edit
the code later and something breaks, that's your first debugging stop.

---

## Part 3 — Use Module 1 (Skeletonizer)

1. Click the extension icon → **Skeletonizer** tab (default)
2. Type a repo as `owner/repo` or paste a full `github.com/...` URL
3. Optionally expand **GitHub token** and paste one in — see Part 5, and
   note that this same token is what powers Module 2's GitHub Overview
   (Part 4.2 below), so it's worth setting even if you don't strictly need
   the higher rate limit for Skeletonizer builds alone
4. Click **Build Tier 1 Pack**
5. You'll see:
   - A token estimate
   - A note on what was trimmed from the tree (`node_modules`, lockfiles, etc.)
   - Which entry files were auto-included in full vs. skeletonized for being
     over the 150-line cap
6. Optionally click **Generate as...** to re-render the same build as
   **Onboarding** (relationships/entry-points first) or **Audit**
   (dependencies first) — this reuses the same fetched content, so it costs
   no extra GitHub calls
7. Click **Copy to Clipboard**, paste as your first message into any Claude
   chat, or attach it to a claude.ai Project's Knowledge manually

**Try this to see the size-cap safeguard in action:** build a pack for
`jashkenas/underscore`. Its `package.json` points at a 2,000+ line main
file — you'll see it listed under "skeletonized," not "included in full,"
because size caps apply regardless of what a file is named or how central
it is.

---

## Part 4 — Use Module 2 (Project Knowledge Manager)

### 4.1 The tracker

1. Click the **Projects** tab
2. Expand **Track a new project**, give it a name (e.g. "AML Motors") and
   its repo, click **Add Project**
3. This immediately runs a first check — you'll see commit history entry #1
   populate right away rather than showing empty until you manually check
4. Click the project row to open its detail view
5. Click **Check for Updates** any time — this makes exactly one GitHub call
   for the latest commit on the default branch:
   - If the SHA hasn't changed, only "Last checked" updates
   - If it has, a new commit-history entry is added (newest first, capped at
     6 — the 7th push evicts the oldest)
6. Click the pin icon (on a row or in the detail view) to pin a project to
   the top of the list — up to 4 at once
7. Click the ✕ icon to stop tracking a project — this only removes it from
   the extension locally; nothing on GitHub is touched

That's the entire tracker. **There is no diffing, no "pushing" a version
anywhere, no Copy/Download/Auto-Upload flow in this tab** — if you used an
earlier build of this extension, see the note at the bottom of this guide.
The only way anything from this extension reaches claude.ai is via the
Skeletonizer tab's own Copy to Clipboard button (Part 3, step 7).

### 4.2 GitHub Overview (new)

Below the tracked-project list, two account-level sections — these reflect
the GitHub identity behind whatever token you've set in the Skeletonizer
tab, independent of which repos you're tracking:

- **This month's contributions** — a GitHub-style heatmap clipped to the
  current UTC calendar month, binary (contributed / not) rather than
  graded. Click the refresh icon to fetch/update it. It also refetches on
  its own, with no click needed, if you open the popup in a new month and
  the cached data is still tagged with the previous one.
- **Recently pushed** — your 2 most recently pushed-or-created repos,
  across your whole account, not just tracked ones. Click its refresh icon
  to fetch/update.

**Both require a GitHub token** (added in the Skeletonizer tab) — the
contribution calendar uses GitHub's GraphQL API, which has no
unauthenticated tier at all, and recently-pushed uses the authenticated
`/user/repos` endpoint. Without a token, each section shows a small inline
prompt instead of attempting a call that would only fail.

Both refresh independently of everything else in the tab — a failed refresh
on either one never affects your tracked-project list or detail view.

### A note on `content.js`

`content.js` (best-effort claude.ai Project-page file upload via a native
file input) still ships in this package and is listed in `manifest.json`,
but **no button in the current UI calls it** — Module 2's tracker doesn't
generate any content to upload, and Module 1's Skeletonizer only offers
Copy to Clipboard. It's inert code, kept in case a future version wires a
"send this pack straight to a claude.ai Project" flow back in. If you don't
plan to build that, it's safe to delete `content.js` and the
`"content_scripts"` — wait, there currently isn't a `content_scripts` entry
in `manifest.json` either, so it's genuinely just an unused file sitting in
the folder today, not something actively injected into claude.ai pages.

---

## Part 5 — GitHub token (raises rate limit, and required for GitHub Overview)

- **For Skeletonizer alone:** optional. Raises the GitHub REST rate limit
  from 60/hr (unauthenticated, per IP) to 5,000/hr.
- **For Module 2's GitHub Overview:** required, for both the contribution
  calendar and recently-pushed. There's no unauthenticated path for either.
- **For Module 2's tracker (Check for Updates):** not required — the
  tracker's single-commit lookup works fine unauthenticated, just subject
  to the same 60/hr cap as any other unauthenticated REST call.

To set one up:

1. GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens (or classic, either works)
2. Generate one with **read-only** access to the repos you care about (no
   write scopes needed — the extension never writes to GitHub). For the
   contribution calendar specifically, make sure the token can read your
   own user data (this is on by default for a token you generate for
   yourself; nothing extra to enable).
3. Paste it into the **GitHub token** field under the Skeletonizer tab —
   it's stored via `chrome.storage.local` (local to your machine, never
   synced anywhere) and only ever sent to `api.github.com`. This is the
   single token both tools read; there's no separate token field anywhere
   else in the UI.

---

## What's genuinely tested vs. what needs your live verification

| Component | Status |
|---|---|
| `lib/github.js` (REST), `lib/skeletonizer.js`, `lib/build.js` | Covered by mocked-network unit + integration tests; the REST wrapper itself has also been exercised against real public repos during development |
| `lib/github.js` (`ghGraphQL`, `getMyRecentRepos`) | Covered by mocked-network tests (`github.overview.test.mjs`) — request shape, auth header, error handling, no-token fast-fail |
| `lib/githubOverview.js` | 15 pure-logic unit tests — month-range math, calendar grid padding/binary states, cache staleness, recent-repo ranking |
| `lib/projectStore.js` | 20 unit tests — create/list/pin/history-cap/migration-safety/duplicate-rejection |
| Tracker end-to-end (`projectsView.js`) | Full integration test against a fake DOM + mocked GitHub — add/check/pin/delete/sort, plus the GitHub Overview's no-token state, manual refresh, and month-rollover auto-refetch |
| Popup UI (tabs, forms, buttons) | Every `getElementById` reference checked against actual HTML ids — no dangling references. **Not click-tested in a live Chrome window** by me, since I don't have a browser in this environment — worth a quick real click-through after loading it |
| Contribution calendar against your real GitHub data | Logic is fully tested against mocked responses; **not verified against your actual live contribution graph** — first real click of the refresh button is worth comparing against your github.com profile |
| `content.js` | Present, syntactically valid, but **not wired into any current button** — see the note in Part 4.2. Not relevant to verify unless you plan to re-wire it. |

---

## What changed since the old push/diff version

If you used an earlier build where Module 2 had a "Check for Updates" button
that rebuilt a full skeleton, diffed it against a previously "pushed"
version, and offered Copy/Download/Auto-Upload — that entire flow has been
removed. Module 2 is now a pure tracker: "Check for Updates" is a single
lightweight commit-SHA lookup, not a full Skeletonizer build, and there's no
concept of a "pushed" version living in Module 2 anymore. If you want that
old copy/paste-into-claude.ai workflow, it still exists — it just lives
entirely in the Skeletonizer tab now (Part 3), decoupled from project
tracking.