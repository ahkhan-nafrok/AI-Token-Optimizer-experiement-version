// lib/diff.js
// Compares two versions of a Tier 1/2 markdown pack at the section level (## headers)
// so a "refresh" tells you what actually changed, not just "content differs."
// Pure functions — no browser or storage APIs — fully unit-testable in Node.

/** Split markdown into { sectionName: sectionBodyText } keyed by "## " headers. */
export function parseSections(markdown) {
  const lines = (markdown || "").split("\n");
  const sections = {};
  let current = "_preamble";
  sections[current] = [];

  for (const line of lines) {
    const match = line.match(/^##\s+(.*)$/);
    if (match) {
      current = match[1].trim();
      sections[current] = sections[current] || [];
    } else {
      sections[current].push(line);
    }
  }

  const out = {};
  for (const [name, bodyLines] of Object.entries(sections)) {
    out[name] = bodyLines.join("\n").trim();
  }
  return out;
}

/**
 * Compare an old pushed version against a newly built one.
 * Returns which sections were added / removed / changed / unchanged,
 * plus a one-line human summary. Never mutates inputs.
 */
export function diffMarkdown(oldMarkdown, newMarkdown) {
  if (!oldMarkdown) {
    const newSections = Object.keys(parseSections(newMarkdown)).filter((k) => k !== "_preamble");
    return {
      isFirstPush: true,
      added: newSections,
      removed: [],
      changed: [],
      unchanged: [],
      summary: "First push to this project — no prior version to compare against.",
    };
  }

  const oldSections = parseSections(oldMarkdown);
  const newSections = parseSections(newMarkdown);
  const allKeys = new Set([...Object.keys(oldSections), ...Object.keys(newSections)]);

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const key of allKeys) {
    const inOld = key in oldSections;
    const inNew = key in newSections;
    // "_preamble" (everything above the first ## header — repo name, description,
    // primary language) always exists on both sides since parseSections seeds it
    // unconditionally, so it can only ever land in changed/unchanged, never
    // added/removed. Give it a readable label in the output either way.
    const label = key === "_preamble" ? "Repo header" : key;

    if (inOld && inNew) {
      (oldSections[key] === newSections[key] ? unchanged : changed).push(label);
    } else if (inNew) {
      added.push(label);
    } else {
      removed.push(label);
    }
  }

  const parts = [];
  if (added.length) parts.push(`${added.length} section(s) added`);
  if (removed.length) parts.push(`${removed.length} section(s) removed`);
  if (changed.length) parts.push(`${changed.length} section(s) changed`);
  if (!parts.length) parts.push("No changes detected");

  return { isFirstPush: false, added, removed, changed, unchanged, summary: parts.join(", ") };
}
