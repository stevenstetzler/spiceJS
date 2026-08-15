/**
 * Pluggable local caches for load() (docs/browser-support.md §3.5): a
 * cache is just `{ get(key) => Promise<Uint8Array|null>, put(key,
 * bytes) => Promise<void> }` -- whole-file only, keyed by whatever
 * string `load()` was called with (a URL, typically). This is *not*
 * the block-aligned, partial-range cache §3.6 describes for lazy
 * loading of huge kernels -- that's future work; every cache here
 * stores one complete kernel's bytes per key.
 *
 * Two implementations ship here:
 *   - createMemoryCache(): works in every environment (including
 *     Node), no persistence beyond the current process -- handy for
 *     tests, or for de-duplicating repeat load()s of the same URL
 *     within one page session without needing IndexedDB at all.
 *   - createIndexedDbCache(): browser-only, persists across page
 *     loads. Feature-detected: throws a clear error immediately if
 *     `indexedDB` isn't available, rather than failing confusingly
 *     deep inside an IndexedDB transaction.
 */

/** An in-memory cache -- works anywhere, no persistence. */
export function createMemoryCache() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, bytes) {
      store.set(key, bytes);
    },
  };
}

/**
 * An IndexedDB-backed cache, for persisting fetched kernels across
 * page loads in a browser. NAIF kernels are immutable once published
 * (see docs/browser-support.md §2), so this caches forever with no
 * revalidation and no eviction -- there's no `delete()`/`clear()`
 * here; if an app needs to force a re-fetch (e.g. it moved to a
 * different kernel release published under the same URL), namespace
 * `dbName`/`storeName` per release, or open `indexedDB` directly to
 * manage entries by hand.
 *
 * @param {object} [options]
 * @param {string} [options.dbName]
 * @param {string} [options.storeName]
 * @param {number} [options.version]
 */
export function createIndexedDbCache({ dbName = 'spicejs-kernel-cache', storeName = 'kernels', version = 1 } = {}) {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      'createIndexedDbCache: indexedDB is not available in this environment -- this cache backend only works ' +
        'in a browser (or with an IndexedDB polyfill, e.g. for tests). Use createMemoryCache() instead, or pass ' +
        'no `cache` option at all.'
    );
  }

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function runRequest(mode, makeRequest) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const request = makeRequest(tx.objectStore(storeName));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        })
    );
  }

  return {
    async get(key) {
      const value = await runRequest('readonly', (store) => store.get(key));
      return value ?? null;
    },
    async put(key, bytes) {
      await runRequest('readwrite', (store) => store.put(bytes, key));
    },
  };
}
