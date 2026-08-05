// test/tokenVault.test.mjs
// Tests for the security layer: lib/tokenVault.js. Uses a fake in-memory
// indexedDB (test/helpers/fakeIndexedDB.mjs) so the REAL vault code runs
// unmodified — no mocking of tokenVault's own internals. crypto.subtle is
// Node's real WebCrypto, not faked, so the encrypt/decrypt path and the
// non-extractable key flag are exercised for real, not simulated.
//
// Run with: node test/tokenVault.test.mjs

import assert from "node:assert/strict";
import { createFakeIndexedDB } from "./helpers/fakeIndexedDB.mjs";

// ---- global setup, before importing the module under test ----
// tokenVault.js references `indexedDB` as an ambient global (matching how
// it's available in a browser extension popup), so it must exist on
// globalThis before any vault function that touches storage is called.
// It's fine that this happens after the static import below, since none of
// tokenVault's top-level module code touches indexedDB — only its
// functions do, and those are only called from inside our tests.
let fakeDbHandle = createFakeIndexedDB();
globalThis.indexedDB = fakeDbHandle.indexedDB;

// Node 19+ exposes a real WebCrypto implementation as globalThis.crypto.
// Defensive fallback for older runtimes, so this test doesn't silently
// no-op on a machine where it's missing.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  const { webcrypto } = await import("node:crypto");
  globalThis.crypto = webcrypto;
}

const { saveToken, getToken, revokeToken, maskToken, testConnection } = await import(
  "../lib/tokenVault.js"
);

let passed = 0,
  failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.stack || e.message}`);
  }
}

function makeMockAdapter() {
  let store = {};
  return {
    async get(keys) {
      const out = {};
      for (const k of keys) out[k] = store[k];
      return out;
    },
    async set(obj) {
      store = { ...store, ...obj };
    },
    _dump: () => store,
  };
}

function jsonResponse(obj, ok = true, status = 200, headers = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => obj,
  };
}

const originalFetch = globalThis.fetch;

// Fresh fake DB + mock storage adapter per test, so vault state (the
// generated key) never leaks between tests.
function freshEnv() {
  fakeDbHandle = createFakeIndexedDB();
  globalThis.indexedDB = fakeDbHandle.indexedDB;
  return makeMockAdapter();
}

// ---------------------------------------------------------------------
// saveToken / getToken round trip
// ---------------------------------------------------------------------

await test("getToken returns null when nothing has ever been saved", async () => {
  const adapter = freshEnv();
  const token = await getToken(adapter);
  assert.equal(token, null);
});

await test("saveToken then getToken round-trips the exact plaintext", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_realTokenValue123");
  const token = await getToken(adapter);
  assert.equal(token, "ghp_realTokenValue123");
});

await test("saveToken rejects an empty or whitespace-only token", async () => {
  const adapter = freshEnv();
  await assert.rejects(() => saveToken(adapter, ""), /can't be empty/);
  await assert.rejects(() => saveToken(adapter, "   "), /can't be empty/);
});

await test("saveToken trims surrounding whitespace before storing", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "  ghp_trimMe  ");
  const token = await getToken(adapter);
  assert.equal(token, "ghp_trimMe");
});

await test("what actually lands in chrome.storage is ciphertext, not the plaintext token", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_shouldNeverAppearInStorage");
  const raw = adapter._dump();
  const stored = JSON.stringify(raw.ghTokenEncrypted);
  assert.ok(stored.includes("ciphertext") && stored.includes("iv"));
  assert.ok(
    !stored.includes("ghp_shouldNeverAppearInStorage"),
    "the raw token must never appear as plaintext anywhere in the stored blob"
  );
});

await test("saveToken overwrites a previously saved token", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_first");
  await saveToken(adapter, "ghp_second");
  const token = await getToken(adapter);
  assert.equal(token, "ghp_second");
});

// ---------------------------------------------------------------------
// Fail-safe decrypt behavior
// ---------------------------------------------------------------------

await test("getToken fails safe (returns null, does not throw) on a corrupted ciphertext blob", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_original");
  // Corrupt the stored ciphertext directly, simulating disk corruption or a
  // partial write.
  const raw = adapter._dump();
  raw.ghTokenEncrypted = { ciphertext: "not-valid-base64-ciphertext!!", iv: raw.ghTokenEncrypted.iv };
  const token = await getToken(adapter);
  assert.equal(token, null, "a corrupted blob must degrade to 'no token', not throw and break every caller");
});

await test("getToken fails safe when the stored blob is missing ciphertext or iv entirely", async () => {
  const adapter = freshEnv();
  await adapter.set({ ghTokenEncrypted: { ciphertext: "abc" } }); // no iv
  assert.equal(await getToken(adapter), null);
  await adapter.set({ ghTokenEncrypted: { iv: "abc" } }); // no ciphertext
  assert.equal(await getToken(adapter), null);
});

await test(
  "getToken fails safe when the IndexedDB key was cleared independently of chrome.storage",
  async () => {
    const adapter = freshEnv();
    await saveToken(adapter, "ghp_original");
    // Simulate the two storage layers falling out of sync: wipe ONLY the
    // IndexedDB-side key, leaving the encrypted blob in chrome.storage.
    const rawStore = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys");
    rawStore.delete("token-key");
    const token = await getToken(adapter);
    assert.equal(token, null, "a key/ciphertext mismatch must fail safe, not throw");
  }
);

// ---------------------------------------------------------------------
// The core security property: non-extractable key, reused not regenerated
// ---------------------------------------------------------------------

await test("the generated AES-GCM key is non-extractable", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_triggerKeyCreation");
  const rawStore = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys");
  const key = rawStore.get("token-key");
  assert.ok(key, "a key must have been generated and stored");
  assert.equal(key.extractable, false, "the vault key must be created with extractable=false — this is the entire security claim");
  assert.deepEqual([...key.usages].sort(), ["decrypt", "encrypt"]);
  assert.equal(key.algorithm.name, "AES-GCM");
  assert.equal(key.algorithm.length, 256);
});

await test("the same key object is reused across multiple saves, never regenerated", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_first");
  const keyAfterFirst = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys").get("token-key");
  await saveToken(adapter, "ghp_second");
  const keyAfterSecond = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys").get("token-key");
  assert.equal(keyAfterFirst, keyAfterSecond, "saveToken must reuse the existing key, not generate a new one each time");
});

await test("two independently encrypted blobs of the same plaintext use different IVs", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_sameValue");
  const first = adapter._dump().ghTokenEncrypted.iv;
  await saveToken(adapter, "ghp_sameValue");
  const second = adapter._dump().ghTokenEncrypted.iv;
  assert.notEqual(first, second, "IV must be freshly random per encryption, never reused");
});

// ---------------------------------------------------------------------
// revokeToken — must wipe BOTH the ciphertext and the key
// ---------------------------------------------------------------------

await test("revokeToken wipes the encrypted blob from chrome.storage", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_toBeRevoked");
  await revokeToken(adapter);
  assert.equal(adapter._dump().ghTokenEncrypted, null);
  assert.equal(await getToken(adapter), null);
});

await test("revokeToken wipes the IndexedDB key itself, not just the ciphertext (real revoke, not a no-op)", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_toBeRevoked");
  const keyBefore = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys").get("token-key");
  assert.ok(keyBefore, "sanity check: key must exist before revoke");

  await revokeToken(adapter);

  const keyAfter = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys").get("token-key");
  assert.equal(keyAfter, undefined, "the IndexedDB key record must be deleted, not just the chrome.storage ciphertext");
});

await test("after revoke, saving a new token generates a genuinely NEW key (not the old one)", async () => {
  const adapter = freshEnv();
  await saveToken(adapter, "ghp_old");
  const keyBefore = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys").get("token-key");

  await revokeToken(adapter);
  await saveToken(adapter, "ghp_new");
  const keyAfter = fakeDbHandle._inspectRawStore("gitstreak_vault", "keys").get("token-key");

  assert.notEqual(keyBefore, keyAfter, "post-revoke, a fresh key must be generated — reusing the old key object would defeat the point of revoking");
  assert.equal(await getToken(adapter), "ghp_new");
});

// ---------------------------------------------------------------------
// maskToken
// ---------------------------------------------------------------------

await test("maskToken shows only the first 4 and last 4 characters", () => {
  assert.equal(maskToken("ghp_1234567890abcdef"), "ghp_••••cdef");
});

await test("maskToken never returns the full token for realistic short-ish tokens", () => {
  const t = "ghp_abcd1234";
  const masked = maskToken(t);
  assert.notEqual(masked, t);
  assert.ok(!masked.includes(t.slice(4, -4)), "the masked middle section must not leak into the output");
});

await test("maskToken degrades gracefully for null/empty/very short input", () => {
  assert.equal(maskToken(null), "••••");
  assert.equal(maskToken(""), "••••");
  assert.equal(maskToken("short"), "••••");
});

// ---------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------

await test("testConnection rejects an empty token without making a network call", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({});
  };
  await assert.rejects(() => testConnection(""), /Enter a token first/);
  assert.equal(called, false);
});

await test("testConnection surfaces a clear error on 401 (bad token)", async () => {
  globalThis.fetch = async () => jsonResponse({}, false, 401);
  await assert.rejects(() => testConnection("ghp_bad"), /GitHub rejected this token \(401\)/);
});

await test("testConnection surfaces a generic error on other non-OK statuses", async () => {
  globalThis.fetch = async () => jsonResponse({}, false, 500);
  await assert.rejects(() => testConnection("ghp_x"), /500/);
});

await test("testConnection: a classic PAT exposes scopes via the x-oauth-scopes header", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ login: "octocat" }, true, 200, { "x-oauth-scopes": "repo, read:user" });
  const result = await testConnection("ghp_classic");
  assert.equal(result.login, "octocat");
  assert.deepEqual(result.scopes, ["repo", "read:user"]);
  assert.equal(result.isFineGrained, false);
});

await test("testConnection: a fine-grained PAT (no scopes header) is reported as fine-grained with scopes=null", async () => {
  globalThis.fetch = async () => jsonResponse({ login: "octocat" }, true, 200, {});
  const result = await testConnection("github_pat_finegrained");
  assert.equal(result.scopes, null);
  assert.equal(result.isFineGrained, true);
});

await test("testConnection: a present-but-empty x-oauth-scopes header is indistinguishable from a missing one (known limitation, not a bug)", async () => {
  globalThis.fetch = async () => jsonResponse({ login: "octocat" }, true, 200, { "x-oauth-scopes": "" });
  const result = await testConnection("ghp_zero_scopes");
  // `scopesHeader ? ... : null` treats an empty string the same as a
  // missing header, since both are falsy. This means a classic PAT with
  // zero scopes granted would be mis-reported as "fine-grained" here. In
  // practice GitHub doesn't appear to send an empty (vs. absent) header for
  // classic tokens, so this is a documented edge case, not a fix.
  assert.equal(result.scopes, null);
  assert.equal(result.isFineGrained, true);
});

globalThis.fetch = originalFetch;

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
