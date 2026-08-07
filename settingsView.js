// settingsView.js
// Settings panel — the token entry/test/revoke flow described in the
// GITSTREAK security layer: masked input, never redisplayed in full,
// test-connection before save, revoke wipes both the encrypted blob and
// the vault key.
//
// UI/UX pass (this session): once a token is saved, the entire entry group
// (label + input + hint + Test/Save buttons + scopes readout) is hidden —
// there is nothing to "re-enter" while a token is already stored, so
// showing that form was dead weight. Only the "Connected as ghp_••••" row
// + Revoke Locally button show while connected. The entry group reappears
// automatically once the token is revoked.
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { saveToken, getToken, revokeToken, maskToken, testConnection } from "./lib/tokenVault.js";

export function initSettingsView() {
  const tokenCard = document.getElementById("settings-token-card");
  const tokenEntry = document.getElementById("settings-token-entry");
  const tokenInput = document.getElementById("settings-token-input");
  const testBtn = document.getElementById("settings-test-btn");
  const saveBtn = document.getElementById("settings-save-btn");
  const revokeBtn = document.getElementById("settings-revoke-btn");
  const statusEl = document.getElementById("settings-status");
  const connectedRow = document.getElementById("settings-connected-row");
  const connectedLabel = document.getElementById("settings-connected-label");
  const scopesEl = document.getElementById("settings-scopes");

  let lastValidated = null; // { login, scopes, isFineGrained } from the most recent successful test-connection

  function setStatus(msg, isError = false) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
  }

  async function refreshConnectedState() {
    const token = await getToken(chromeStorageAdapter);
    const isConnected = !!token;

    tokenCard.classList.toggle("is-connected", isConnected);
    tokenEntry.hidden = isConnected;
    connectedRow.hidden = !isConnected;

    if (!isConnected) {
      saveBtn.disabled = true;
      return;
    }
    connectedLabel.textContent = `Connected as ${maskToken(token)}`;
  }

  testBtn.addEventListener("click", async () => {
    const raw = tokenInput.value;
    testBtn.disabled = true;
    saveBtn.disabled = true;
    setStatus("Testing connection...");
    scopesEl.hidden = true;
    try {
      const result = await testConnection(raw);
      lastValidated = result;
      const scopeText = result.isFineGrained
        ? "Fine-grained token — scopes aren't exposed via this check, but the connection is valid."
        : `Scopes: ${result.scopes.length ? result.scopes.join(", ") : "(none granted)"}`;
      scopesEl.textContent = `Signed in as ${result.login}. ${scopeText}`;
      scopesEl.hidden = false;
      setStatus("");
      saveBtn.disabled = false;
    } catch (e) {
      lastValidated = null;
      setStatus(e.message, true);
      saveBtn.disabled = true;
    } finally {
      testBtn.disabled = false;
    }
  });

  // Editing the token after a successful test invalidates that test — force
  // re-verification before allowing save, so what's saved is always what
  // was actually checked.
  tokenInput.addEventListener("input", () => {
    lastValidated = null;
    saveBtn.disabled = true;
    scopesEl.hidden = true;
  });

  saveBtn.addEventListener("click", async () => {
    const raw = tokenInput.value;
    if (!lastValidated) {
      setStatus("Test the connection first.", true);
      return;
    }
    saveBtn.disabled = true;
    setStatus("Saving...");
    try {
      await saveToken(chromeStorageAdapter, raw);
      tokenInput.value = "";
      lastValidated = null;
      scopesEl.hidden = true;
      setStatus("Token saved.");
      await refreshConnectedState();
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      saveBtn.disabled = true; // re-enabled only after a fresh test-connection
    }
  });

  revokeBtn.addEventListener("click", async () => {
    if (!confirm("Remove the saved GitHub token from this browser? Pulse and private-repo tracking will stop working until you add a new one. This does not revoke the token on GitHub's side — do that at github.com/settings/tokens if needed.")) {
      return;
    }
    try {
      await revokeToken(chromeStorageAdapter);
      setStatus("Token removed locally.");
      await refreshConnectedState();
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  refreshConnectedState();
}