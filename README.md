# Token Optimizer — Setup & Test Guide

## What's in this package

```
token-optimizer-extension/
├── manifest.json          # Manifest V3 config
├── popup.html/css/js      # UI shell + tab switching
├── skeletonizerView.js    # Module 1 UI logic
├── projectsView.js        # Module 2 UI logic
├── content.js             # Runs on claude.ai — experimental auto-upload
├── lib/
│   ├── github.js           # GitHub REST API wrapper (read-only)
│   ├── skeletonizer.js     # Tier 1 compression + entry-file size-cap heuristic
│   ├── build.js             # Orchestrates github.js + skeletonizer.js
│   ├── diff.js              # Section-level diff engine (pure, no deps)
│   ├── projectStore.js      # Project registry logic (pure, no deps)
│   └── storageAdapter.js    # chrome.storage.local wrapped in Promises
├── test/
│   ├── module2.test.mjs      # 16 unit tests — diff.js + projectStore.js
│   └── integration.test.mjs  # End-to-end test against a real GitHub repo
└── icons/                  # Placeholder icons (replace anytime — cosmetic only)
```

**Zero npm dependencies.** No `package.json`, no `node_modules`, nothing to `npm install`. This was a deliberate choice — the extension itself only uses browser-native APIs (`fetch`, `chrome.storage`, `chrome.downloads`, `DataTransfer`), so there's nothing that can go stale or break from a dependency update. The only thing you need installed to run the *tests* is Node.js itself (any reasonably recent version — developed against Node 22, but nothing here uses bleeding-edge syntax).

---

## Part 1 — Run the automated tests (no browser needed)

This validates the logic layer: diffing, storage, capacity warnings, and the full GitHub → skeleton pipeline against a real repo.

```bash
cd token-optimizer-extension

# Unit tests — pure logic, no network, runs instantly
node test/module2.test.mjs

# Integration test — hits the real GitHub API once
node test/integration.test.mjs
```

Expected output: `16 test(s) passed.` for the unit tests, `All integration checks passed.` for the integration test.

**If the integration test fails with "GitHub rate limit hit":** that's not a bug — unauthenticated GitHub API access is capped at 60 requests/hour *per IP*. If you've been testing a lot from the same network, you'll hit it. Either wait for the reset time shown in the error, or add a token (see "Optional: GitHub token" below) — it isn't required to just read the code, only to keep testing rapidly.

---

## Part 2 — Load the extension in Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select the `token-optimizer-extension` folder
5. Pin it to your toolbar (puzzle-piece icon → pin) so it's one click away

If Chrome shows a red error badge on the extension card instead of loading it, click it — it'll tell you exactly which file/line failed. Given the syntax checks above all pass, this shouldn't happen, but if you edit the code later, that's your first debugging stop.

---

## Part 3 — Use Module 1 (Skeletonizer)

1. Click the extension icon → **Skeletonizer** tab (default)
2. Type a repo as `owner/repo` or paste a full `github.com/...` URL
3. Click **Build Tier 1 Pack**
4. You'll see:
   - A token estimate
   - A note on what was trimmed from the tree (`node_modules`, lockfiles, etc.)
   - Which entry files were auto-included in full vs. skeletonized for being over the 150-line cap
5. Click **Copy to Clipboard**, paste as your first message into any Claude chat

**Try this to see the size-cap safeguard in action:** build a pack for `jashkenas/underscore`. Its `package.json` points at a 2,000+ line main file — you'll see it listed under "skeletonized," not "included in full," because size caps apply regardless of what a file is named or how central it is.

---

## Part 4 — Use Module 2 (Project Knowledge Manager)

1. Click the **Projects** tab
2. Expand **+ Track a new project**, give it a name (e.g. "AML Motors") and its repo, click **Add Project**
3. Click the project row to open it
4. Click **Check for Updates** — this builds a fresh skeleton and diffs it against whatever was last pushed (first time, it'll say "First push — no prior version")
5. Choose how to get it into claude.ai's Project Knowledge:
   - **Copy to Clipboard** — safest, always works, paste into Project Knowledge manually
   - **Download .md File** — saves to your Downloads folder, drag into Project Knowledge
   - **Try Auto-Upload (experimental)** — see the honesty note below before relying on this

Once you've acted on any of the three, the extension records that version as "pushed" so the next **Check for Updates** diffs against it — you'll see something like `2 section(s) changed` instead of a full re-read.

### Important honesty note on "pushed" state

The extension can't verify that a paste/upload actually landed in claude.ai's Project Knowledge — it only knows you *clicked* the button. If you click Copy but then don't actually paste it anywhere, the extension's local record will say "pushed" even though claude.ai's side never changed. Next time you check for updates, it'll diff against a version that only exists locally, not on claude.ai. If that happens, just re-push — worst case is one redundant paste, not silent data loss.

### About the "Try Auto-Upload" button specifically

This is genuinely experimental, and I want to be direct about why: it works by having `content.js` look for a file-upload input on the current claude.ai page and populate it programmatically. I wrote the selector logic (text-matching buttons like "Add content," looking for `input[type="file"]`) based on reasonable patterns for this kind of UI, but **I have no way to load and inspect the live claude.ai DOM from this environment**, so I can't confirm those selectors match the actual page today. It's built to fail loudly and specifically rather than silently — if it can't find what it's looking for, it tells you exactly what it tried and falls back cleanly. Test it once on a low-stakes project first. If it doesn't work, Copy and Download are the reliable paths and always will be, regardless of what claude.ai's UI does over time.

---

## Part 5 — Optional: GitHub token (raises rate limit 60/hr → 5,000/hr)

Only needed if you're refreshing many projects frequently and hitting rate limits.

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Generate one with **read-only** access to the repos you want (no write scopes needed — the tool never writes to GitHub)
3. Paste it into the "GitHub token" field under the Skeletonizer tab — it's stored via `chrome.storage.local` (local to your machine, not synced anywhere) and only ever sent to `api.github.com`

---

## What's genuinely tested vs. what needs your live verification

Being precise about this, since you asked for no hand-waving:

| Component | Status |
|---|---|
| `lib/github.js`, `lib/skeletonizer.js`, `lib/build.js` | Verified against 3 real public repos (`is-npm`, `underscore`, plus repeated runs), including the adversarial size-cap case |
| `lib/diff.js` | 6 unit tests, including a regression test for a real bug I found and fixed (preamble changes were being silently ignored) |
| `lib/projectStore.js` | 8 unit tests covering create/list/push/history-cap/delete/duplicate-rejection |
| Full pipeline wiring (Module 1 → Module 2) | 1 integration test, passed against a live repo |
| Popup UI (tabs, forms, buttons) | Every `getElementById` reference checked against actual HTML ids — no dangling references. Not click-tested in an actual browser by me, since I don't have one here |
| `content.js` auto-upload | Syntax-valid, logically defensive (fails with clear reasons rather than silently), **not verified against live claude.ai DOM** — this is the one piece that needs your eyes on it |

If the auto-upload path doesn't work as-is, the fix is almost certainly just updating the selectors in `content.js`'s `findAddContentTrigger()` function to match whatever claude.ai's current "Add content" button actually looks like — open devtools on the Project Knowledge page, inspect the button, and adjust the text-match regex or add a more specific selector.
