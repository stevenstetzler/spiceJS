/**
 * Per-pool record of what furnsh()/load() loaded from each kernel
 * reference (a local path, a URL, or any other key), so unload() can
 * undo it and kclear() can forget it. Keyed by pool identity (a
 * WeakMap) so isolated pools (e.g. in tests) don't share load
 * history. This module has no fs/path/network dependency at all, and
 * is shared by every entry point that needs to register or undo a
 * load:
 *   - kernels.js's furnsh()/unload()/kclear() (Node, `fs`-backed).
 *   - load.js's load(), via kernelBytes.js's decodeKernel() (URL/
 *     File/bytes-backed, environment-agnostic).
 *   - browser.js's own unload()/kclear() (the browser-safe entry
 *     point -- see unloadKey()/kclearPool() below).
 * A kernel is unloadable/forgettable the same way no matter which of
 * these loaded it, since they all share this one registry per pool.
 */
const registries = new WeakMap();

export function registryFor(pool) {
  let registry = registries.get(pool);
  if (!registry) {
    registry = new Map();
    registries.set(pool, registry);
  }
  return registry;
}

/**
 * Undo whatever was registered under `key` (a `furnsh()`-resolved
 * absolute path, or a `load()`-style URL/bytes key) -- pure pool
 * mutation, no I/O, no knowledge of *how* `key` was computed. Both
 * kernels.js's `unload()` (which resolves a local path or passes a
 * URL through) and browser.js's `unload()` (which never has a local
 * path to resolve at all -- every key it sees is already exactly
 * what load() registered) call this with their own idea of `key`; the
 * actual undo logic lives here exactly once.
 */
export function unloadKey(key, pool) {
  const registry = registryFor(pool);
  const entry = registry.get(key);
  if (!entry) return;

  if (entry.type === 'text') {
    for (const { name, hadPrevious, previousValue } of [...entry.changes].reverse()) {
      if (hadPrevious) {
        pool.putValues(name, previousValue, false);
      } else {
        pool.deleteVar(name);
      }
    }
  } else if (entry.type === 'spk') {
    pool.removeSpkSegments(entry.segments);
  } else if (entry.type === 'pck') {
    pool.removePckSegments(entry.segments);
  } else if (entry.type === 'ck') {
    pool.removeCkSegments(entry.segments);
  }
  // 'meta' entries have nothing of their own to undo.

  registry.delete(key);
}

/** Clear a pool and forget all load history -- shared by kernels.js's and browser.js's kclear(). */
export function kclearPool(pool) {
  pool.clear();
  registryFor(pool).clear();
}
