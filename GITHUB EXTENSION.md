# Token Optimizer — Browser Extension

A Chrome extension with two independent tools. They share a popup and a design
system — nothing else. No shared code, no shared data, no assumptions about
each other, and no shared logic between them anywhere in the codebase.

1. **Skeletonizer** — turns a GitHub repo into a compact, structured context
   pack, purpose-built for one reader: Claude.
2. **Project Knowledge Manager** — tracks a set of GitHub repos and tells you,
   at a glance, which ones have moved upstream since you last looked. It also
   surfaces an account-level **GitHub Overview**: a current-month contribution
   calendar and your most recently pushed/created repos — a quick "what have
   I been doing on GitHub" glance without opening github.com.

No backend server. Nothing leaves the machine except calls to
`api.github.com` (REST and GraphQL) and, optionally, an attempt to place a
file into a claude.ai Project page. All local state lives in
`chrome.storage.local`.

---

## 1. Skeletonizer

### What it produces

Given `owner/repo` (or a full GitHub URL), it builds one markdown document
containing:

- A trimmed file tree — build output, lockfiles, binaries, and common
  ignore-worthy directories (`node_modules`, `dist`, `.venv`, `target`,
  `__pycache__`, and similar) excluded.
- A condensed README (badges and license boilerplate stripped, content
  otherwise preserved up to an 8,000-character cap with fence-safe
  truncation).
- A dependency summary built from **every** manifest file found in the repo —
  not just the root one. A monorepo with multiple manifests (e.g.
  `package.json` in several sub-packages) gets each one summarized
  separately and clearly labeled.
- The full source of detected entry files, when they're under a 150-line cap.
- A structural skeleton — function/class/export signatures only — for entry
  files that exceed the cap, so oversized files still contribute something
  instead of being silently reduced to a line count.
- A relationships section listing which entry files import which other local
  files, so the reader sees how the codebase actually connects, not just a
  list of isolated files.

### Entry-file detection

Entry files are found two ways, with manifest signal always taking priority
over filename guessing:

- **Manifest-based**: a manifest's declared `main`/`start` entry is trusted
  first, resolved relative to *that manifest's own directory* — correct
  behavior for monorepos, where a sub-package's entry is relative to the
  sub-package, not the repo root.
- **Platform-manifest-based**: if the repo has a browser-extension
  `manifest.json`, its declared popup/options/background/content-script
  entries are used directly. If a named entry is an HTML file, any
  `<script src="...">` it references is followed too, so the HTML shell isn't
  a dead end.
- **Filename-pattern fallback**: only used when no manifest signal exists.
  Covers common conventions (`index.js`, `main.py`, Next.js `app/page.tsx`,
  Django `manage.py`, Rust `src/main.rs`, static extension entries like
  `popup.js`/`background.js`, and more). Filename alone never grants
  automatic inclusion — every candidate, however it was found, still goes
  through the size rules below.

### Size handling

- Under the entry-file line cap (150 lines) → included in full.
- Over the cap → skeletonized: function/class/export signatures only,
  extracted per-language via regex (JS/TS, Python, Go, Rust supported;
  unrecognized languages degrade gracefully to an empty signature list, never
  a crash).
- Over a byte-size guard (20,000 bytes, checked against GitHub's own reported
  file size) → never downloaded at all. Its existence and an estimated line
  count are recorded instead of spending a fetch on a file that was always
  going to be discarded.
- A file that was genuinely attempted and failed to fetch is recorded as
  failed, not silently dropped. Every candidate is accounted for somewhere:
  included, skeletonized, or failed.

### Caching

A previous build's `{ path: { sha, content } }` cache can be passed back in.
Any path whose GitHub blob SHA still matches the cached SHA is reused with
zero network calls. Anything else — changed SHA, missing cache entry, or a
mismatched/corrupted cache — is always refetched. A cache is never trusted on
anything less than an exact SHA match, including cases where both sides are
`null`.

### Output templates

Beyond the default output, two fixed templates reorder the same five
sections (Structure, Dependencies, Entry points, Relationships, README) with
a one-line framing sentence, for different reading purposes:

- **Onboarding** — Relationships and Entry points first, for understanding
  how a codebase fits together.
- **Audit** — Dependencies first, for reviewing what a project depends on.

Templates never change what gets extracted, fetched, or skeletonized — they
only reorder and re-frame sections that already exist. A section is omitted
from a templated render only when it's genuinely empty (e.g. no README
found); the default, untemplated output always shows all five sections
regardless. Generating a template reuses the same SHA-checked cache as a
normal build, so re-rendering a repo you just built costs no extra GitHub
calls.

### Determinism

No LLM is used anywhere in this pipeline. Every extraction step — manifest
parsing, entry detection, signature extraction, import extraction, template
rendering — is plain deterministic code. The same repo state always produces
the same output, and the whole pipeline is unit-testable without network
access or an API key.

---

## 2. Project Knowledge Manager

A repo tracker, and only a repo tracker, plus an account-level GitHub
Overview (section 3 below). For each tracked repo it records:

- **Last checked** — the moment you last clicked "Check for Updates,"
  updated every time you click it, regardless of outcome.
- **Commit history** — a short log of the repo's actual commits over time,
  which only grows when GitHub's latest commit is genuinely different from
  what was last recorded. Checking a repo with no new commits updates "last
  checked" but leaves the commit history untouched.

There is no content generation, no diffing of file contents, and no upload
of anything, anywhere in this tool's tracker half. It answers exactly one
question per click: *has this repo's default branch moved since I last
looked, and if so, when?*

### Data model, per tracked project

- `name`, `repo` — as entered when tracking started.
- `lastCheckedAt` — a single timestamp, overwritten unconditionally on every
  check.
- `commitHistory` — an array of `{ sha, commitDate }`, newest first, capped
  at 6 entries (FIFO — the oldest is dropped once a 7th would be added).
- `pinned` — up to 4 projects can be pinned at once. Pinning a 5th is
  rejected outright. Re-pinning an already-pinned project is a no-op and
  never counts against the cap.
- `lastCommitAt` — derived from the newest `commitHistory` entry, never
  stored separately, so it can't drift out of sync with the history it
  reads from.

### Check logic

Checking for updates does exactly this:

1. Resolve the repo's default branch and fetch the single latest commit on
   it — a real SHA and commit date, via one lightweight GitHub call,
   independent of a full Skeletonizer build.
2. Compare that SHA against the most recent stored history entry.
   - **Same SHA** → no-op. Nothing appended, no timestamp changes.
   - **Different SHA (or no prior entry)** → a new entry is added to the
     front of `commitHistory`, trimmed back to 6 if needed.
3. `lastCheckedAt` is stamped with the current time regardless of which
   branch above was taken.

A missing SHA is never treated as matching another missing SHA — only a
genuine, non-null match counts as "no change."

### First add

When a repo is first tracked, the check above runs immediately, so commit
history entry #1 exists right away rather than waiting for a manual check.
If that initial fetch fails, the project is still created — the failure is
surfaced inline and can be retried with a normal "Check for Updates" click.

### Sorting

The tracked-project list is ordered by:

1. Pinned projects first, unpinned after.
2. Within each group, most-recently-committed repo first.
3. A project never successfully checked bubbles to the top of its group — it
   needs attention before one that's already been read.
4. Ties within a "never checked" group fall back to alphabetical order.

### What the tracker deliberately does not do

- No content generation, upload, or export of any kind.
- No diffing of file contents between checks — only commit identity (SHA).
- No global "check all" action — every check is per-repo, individually
  triggered.
- No dependency on, or interaction with, the Skeletonizer.

---

## 3. GitHub Overview (Project Knowledge Manager, account-level)

Two additions sitting below the tracked-project list, always visible
regardless of whether a project is selected. Both are **account-level**
facts about the GitHub identity behind your token — not tied to any one
tracked repo, and not stored anywhere near the `projects` data. A quick way
to check "what have I actually been doing on GitHub this month" without
leaving the extension.

### 3.1 This month's contributions

A GitHub-style contribution heatmap, clipped to the **current UTC calendar
month only** — not a rolling 12-month strip like github.com's profile page.

- **Binary, not graded.** Each day is either *contributed* (filled cell) or
  *not* (dim cell) — a plain `count > 0` threshold, never GitHub's 4-shade
  intensity scale. Whether a day had 1 contribution or 40, it reads the same.
- **Real GitHub geometry.** Columns are weeks, rows are Sun→Sat top to
  bottom, matching github.com's own layout — just clipped to one month.
  Days before the 1st or after the last day of the month (padding needed to
  complete the grid) render as fully blank cells, never a third state.
- **Data source: GitHub's GraphQL API**, not REST — specifically
  `viewer { contributionsCollection { contributionCalendar { ... } } }`.
  This is the same underlying data github.com's own profile heatmap is drawn
  from, so it matches what you'd see on github.com exactly (including
  private-repo contributions, if your token has that scope).
- **`viewer`, not `user(login: ...)`.** The token itself identifies whose
  data this is — no GitHub username is ever stored or needs to be kept in
  sync anywhere in the extension.
- **Requires a GitHub token.** Unlike REST, GraphQL has no unauthenticated
  tier at all. Without a token, this section shows a small inline prompt
  ("Add a GitHub token in the Skeletonizer tab to see this") instead of
  attempting a call that would only fail.
- **Manual refresh only.** Opening the Projects tab never silently spends a
  GraphQL call — the calendar shows whatever was last fetched (cached in
  `chrome.storage.local`) until you click refresh.
- **Automatic month-rollover exception.** The one case that refetches
  *without* a manual click: if the cached data's month no longer matches the
  real current UTC month (e.g. you open the popup on August 1st with a July
  cache sitting in storage), it's treated as stale and refetched
  automatically. This is a correctness fix, not a "did anything change"
  check — showing last month's grid under a "this month" label would just be
  wrong, regardless of whether the person has clicked refresh recently.
- **UTC month boundaries.** "This month" is computed in UTC, matching
  GitHub's own day-bucketing convention. A commit made late at night in a
  timezone ahead of UTC can land in the *next* UTC day's bucket — same
  behavior you'd see comparing against github.com itself.

### 3.2 Recently pushed

Your 2 most recently pushed-or-created repos, account-wide — not limited to
repos you're already tracking. The point is a quick "what did I touch last"
glance independent of your tracked list.

- **Ranking: `max(created_at, pushed_at)`, not just `pushed_at`.** A
  brand-new repo with no pushes yet still surfaces if it's the most recently
  *created* thing on the account — "recently pushed or created" is taken
  literally, not approximated by GitHub's own pushed-only sort.
- **Capped at 2 entries**, always the top-ranked by the rule above.
- **Requires a GitHub token** — uses the authenticated `/user/repos` REST
  endpoint (identity from the token, same reasoning as `viewer` above; no
  separate username storage). Same inline prompt as the calendar when no
  token is present.
- **Manual refresh only**, same as the calendar — a cached result is shown
  until the refresh button is clicked again. No auto-fetch on tab open.

### 3.3 Shared rules for both

- **Storage is separate from tracked projects.** Two new top-level
  `chrome.storage.local` keys (`ghContributionCache`, `ghRecentRepos`) hold
  this data — completely independent of the `projects` key and
  `lib/projectStore.js`'s migration-safety rules. Deleting or corrupting one
  never affects the other.
- **Token is shared storage, not shared logic.** Both features read the same
  `ghToken` key the Skeletonizer tab already writes when you add a token
  there — there's no separate token field for the Projects tab. This is
  "shared storage," which the architecture allows; it is not "shared logic,"
  which it doesn't. `projectsView.js` reads that key independently; nothing
  about how Skeletonizer stores or uses it is touched.
- **Never blocks the tracker.** Both sections load independently of the
  tracked-project list and detail view. A GraphQL failure, a missing token,
  or a rate limit on either Overview section never affects pinning,
  checking, or viewing tracked-project commit history.

---

## 4. Reliability rules (all tools)

- Every comparison that decides "has this changed?" — SHA matching in the
  Project Knowledge Manager's tracker, blob-SHA cache matching in the
  Skeletonizer, month-key matching in the contribution calendar — is
  defensive by default: a missing or null value on either side of a
  comparison is never treated as a match. The safe failure mode is always
  "treat it as changed / refetch it," never "assume nothing changed."
- Every data field added after the extension's initial release has a
  migration-safe default, so a project or cache entry saved under an older
  version is read correctly rather than crashing.
- Compression/extraction never silently drops information — what was
  trimmed, skeletonized, or failed to fetch is always shown, not hidden.
- Malformed or unexpected API responses degrade to an empty/safe result
  (empty contribution map, empty repo list) rather than throwing and taking
  down the rest of the popup with them.
- Read-only against GitHub. No writes anywhere except: clipboard, an
  explicitly-triggered attempt to place a file into a claude.ai Project page,
  and local `chrome.storage`.

---

## 5. Project structure

```
├── icons/
├── lib/
│   ├── build.js             orchestrates github.js + skeletonizer.js → buildTier1(); also owns
│   │                        section-based assembly and named output templates (renderWithTemplate)
│   ├── diff.js              section-level (## header) markdown diff, pure and unit-testable
│   ├── github.js            read-only GitHub REST wrapper (meta, tree, readme, file content,
│   │                        latest commit, my-recent-repos) PLUS a GraphQL wrapper (ghGraphQL)
│   │                        used only by the GitHub Overview's contribution calendar
│   ├── githubOverview.js    pure, deterministic logic for the GitHub Overview: month-range
│   │                        computation, contribution-calendar parsing/grid-building, cache
│   │                        staleness (month rollover), and recent-repo ranking. No network
│   │                        calls, no chrome.storage — fully unit-testable in Node.
│   ├── projectStore.js      chrome.storage.local persistence for tracked projects (tracker only —
│   │                        never touched by the GitHub Overview additions)
│   ├── skeletonizer.js      deterministic Tier 1/2 extraction — manifests, entry detection,
│   │                        signatures, relationships, size guards
│   └── storageAdapter.js    thin Promise wrapper — the only file that touches chrome.storage
├── test/                    unit + integration tests, mocked network and storage throughout
├── content.js               best-effort claude.ai Project-page file upload, with an honest
│                            fallback (Copy/Download) if the page structure doesn't match
├── manifest.json            Chrome extension manifest (MV3)
├── popup.html / popup.css / popup.js   UI shell — tabbed, dark glass, monochrome design system
├── projectsView.js          Project Knowledge Manager UI logic — tracker (create/pin/check/remove)
│                            PLUS the GitHub Overview wiring (calendar + recently pushed)
└── skeletonizerView.js      Skeletonizer UI logic — build, and the Generate-as-template flow
```

---

## 6. Design system

Monochrome throughout — near-black graphite surfaces, low-opacity white glass
panels with `backdrop-filter: blur()`, off-white primary text, mid-grey
secondary text. There is no hue anywhere in the interface: the primary CTA,
pinned-project indicator, progress fill, focus ring, and the contribution
calendar's "contributed" state all read through contrast and motion rather
than color.

- **Primary buttons** (Build, Add Project, Check for Updates): solid
  off-white surface on black, diagonal sheen and lift on hover.
- **Ghost buttons** (Copy, template options, GitHub Overview refresh
  buttons): transparent with a hairline border, background lightens on
  hover.
- **Staleness and destructive states** are distinguished by weight, icon, and
  motion — not by color.
- **Pinned rows**: a plain white-tinted glass background, no divider or
  header — spacing and tint only.
- **Never-checked rows**: a dashed border and a pulsing outline dot, reading
  as "needs attention" through shape and motion rather than a warning hue.
- **Contribution calendar cells**: binary states only, distinguished by fill
  vs. dim + a subtle glow on "contributed" — never a color gradient. Blank
  (out-of-month) cells are fully transparent, not a third visual state.
- **GitHub Overview refresh buttons**: same rotating-arrow icon language as
  the tracker's "Check for Updates" button, so the "this re-checks GitHub"
  affordance reads consistently across every part of the Projects tab.

---

## 7. Installation

1. `chrome://extensions` → enable Developer Mode.
2. "Load unpacked" → select the project folder.
3. Add a GitHub personal access token in the Skeletonizer tab. This is
   **optional** for the Skeletonizer itself (raises the API rate limit from
   60/hr to 5,000/hr) but **required** for the Projects tab's GitHub
   Overview — the contribution calendar (GraphQL has no unauthenticated
   tier at all) and recently-pushed list (uses the authenticated
   `/user/repos` endpoint) both need it. Stored locally, sent only to
   `api.github.com`.

---

## 8. Testing

Every extraction rule, cache decision, sort order, pinning rule, contribution
grid computation, and ranking rule above is covered by a unit or integration
test — mocked GitHub REST and GraphQL responses, mocked `chrome.storage`, no
live network calls and no rate-limit risk when running the suite. Run any
test file directly with `node test/<file>.mjs`.

| Test file | Covers |
|---|---|
| `skeletonizer.test.mjs` | Tree filtering, README condensing, content-fetch planning |
| `skeletonizer.contextupgrade.test.mjs` | Monorepo manifests, signature/import extraction, size guard |
| `build.cache.test.mjs` | SHA-based build caching (cold/warm/changed/corrupted) |
| `build.templates.test.mjs` | Onboarding/Audit template rendering, empty-section skipping |
| `module2.test.mjs` | `projectStore.js` — create/pin/history/migration safety |
| `integration.test.mjs` | Tracker check-for-updates flow end-to-end (mocked GitHub) |
| `sortProjectsForList.test.mjs` | Pinned + recency + never-checked sort ordering |
| `projectsView.integration.test.mjs` | The real `projectsView.js` end-to-end: tracker flow, no-token GitHub Overview state, calendar/recent-repos refresh, month-rollover auto-refetch |
| `githubOverview.test.mjs` | Pure logic: month-range math, calendar grid building, cache staleness, repo ranking |
| `github.overview.test.mjs` | Mocked-network: `ghGraphQL` and `getMyRecentRepos` request/response handling |
