// test/helpers/fakeIndexedDB.mjs
// Minimal in-memory stand-in for the browser's indexedDB — covers only the
// surface lib/tokenVault.js actually calls: indexedDB.open (with
// onupgradeneeded / onsuccess / onerror), db.objectStoreNames.contains,
// db.createObjectStore, db.transaction(storeName, mode).objectStore(name)
// .get/.put/.delete, and tx.oncomplete / tx.onerror. This is NOT a general
// IndexedDB polyfill — it exists purely to let tokenVault.js's real code
// run unmodified under Node.
//
// Each createFakeIndexedDB() call returns an isolated instance so tests
// don't leak vault state into each other.

function makeRequest() {
  return { result: undefined, error: null, onsuccess: null, onerror: null };
}

export function createFakeIndexedDB() {
  const databases = new Map(); // dbName -> { stores: Map<storeName, Map<key,value>> }

  function getOrCreateDbRecord(name) {
    if (!databases.has(name)) databases.set(name, { stores: new Map() });
    return databases.get(name);
  }

  const fakeIndexedDB = {
    open(name) {
      const req = makeRequest();
      queueMicrotask(() => {
        const dbRecord = getOrCreateDbRecord(name);
        const needsUpgrade = dbRecord.stores.size === 0;

        const dbHandle = {
          objectStoreNames: {
            contains: (storeName) => dbRecord.stores.has(storeName),
          },
          createObjectStore(storeName) {
            dbRecord.stores.set(storeName, new Map());
          },
          transaction(storeName) {
            const store = dbRecord.stores.get(storeName);
            const tx = { oncomplete: null, onerror: null, error: null };
            const objectStore = {
              get(key) {
                const opReq = makeRequest();
                queueMicrotask(() => {
                  opReq.result = store.get(key);
                  if (opReq.onsuccess) opReq.onsuccess();
                });
                return opReq;
              },
              put(value, key) {
                store.set(key, value);
                queueMicrotask(() => {
                  if (tx.oncomplete) tx.oncomplete();
                });
              },
              delete(key) {
                store.delete(key);
                queueMicrotask(() => {
                  if (tx.oncomplete) tx.oncomplete();
                });
              },
            };
            tx.objectStore = () => objectStore;
            return tx;
          },
        };

        req.result = dbHandle;
        if (needsUpgrade && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };

  return {
    indexedDB: fakeIndexedDB,
    /** Reach past the vault's abstraction to inspect the raw stored value —
     * used to assert things like "the same CryptoKey object is reused
     * across calls" or "extractable is false" that the public API doesn't
     * expose. */
    _inspectRawStore(dbName, storeName) {
      const db = databases.get(dbName);
      return db ? db.stores.get(storeName) : undefined;
    },
    _reset() {
      databases.clear();
    },
  };
}
