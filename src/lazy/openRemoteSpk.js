/**
 * The public entry point for lazily-loaded SPK kernels -- see
 * `docs/lazy-loading.md`. Fetches nothing beyond the file's length
 * until `prefetch()` is called; every `prefetch()` call is
 * incremental (already-fetched bytes are never re-fetched) and
 * idempotent (already-registered segments are never re-added to
 * `pool`), so it's fine to call it repeatedly -- progressively
 * widening the time window, or for a different target/observer pair
 * against the same file.
 *
 * ```js
 * const remote = await openRemoteSpk('https://your-cors-enabled-host/de440.bsp', { cache });
 * await remote.prefetch({ target: 399, observer: 0, etStart: t1, etEnd: t2, lightTimeMargin: 4.5 * 3600 });
 * // Ordinary, synchronous, completely unmodified spkez() from here:
 * const { position, velocity } = spkez(399, 0, someEtBetweenT1AndT2, 'LT+S', null, remote.pool);
 * ```
 */
import { openRemoteFile } from './remoteFile.js';
import { prefetchSpkQuery } from './prefetch.js';
import { KernelPool } from '../pool.js';

/**
 * @param {string} url
 * @param {object} [options] - see `remoteFile.js`'s `openRemoteFile()` for `fileLength`/`getFileLength`/
 *   `resolveRange`/`cache`/`blockBytes`
 * @returns {Promise<{ pool: import('../pool.js').KernelPool, remoteFile: import('./remoteFile.js').RemoteFile,
 *   prefetch: (query: object) => Promise<void> }>}
 */
export async function openRemoteSpk(url, options = {}) {
  const remoteFile = await openRemoteFile(url, options);
  const pool = new KernelPool();
  return {
    pool,
    remoteFile,
    prefetch: (query) => prefetchSpkQuery(remoteFile, pool, query),
  };
}
