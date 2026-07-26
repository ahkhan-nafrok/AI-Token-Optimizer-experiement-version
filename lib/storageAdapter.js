// lib/storageAdapter.js
// Wraps chrome.storage.local's callback API in Promises. This file is the
// ONLY place that touches chrome.storage directly — projectStore.js takes
// this as an injected dependency, which is what makes projectStore testable
// outside a browser.

export const chromeStorageAdapter = {
  get(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
  },
  set(obj) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  },
};
