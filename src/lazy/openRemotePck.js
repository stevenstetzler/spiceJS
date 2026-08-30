/**
 * The public entry point for lazily-loaded binary PCK kernels --
 * mirrors `openRemoteSpk.js` exactly, just for body-orientation data
 * instead of trajectories. See `docs/lazy-loading.md`.
 *
 * ```js
 * const remote = await openRemotePck('https://your-cors-enabled-host/moon_pa.bpc', { cache });
 * await remote.prefetch({ frame: 31008, etStart: t1, etEnd: t2 }); // MOON_PA_DE440
 * // Ordinary, synchronous, completely unmodified rotateState()/spkez({ref: ...}) from here.
 * ```
 */
import { openRemoteFile } from './remoteFile.js';
import { prefetchPckQuery } from './pckPrefetch.js';
import { KernelPool } from '../pool.js';

/**
 * @param {string} url
 * @param {object} [options] - see `remoteFile.js`'s `openRemoteFile()` for `fileLength`/`getFileLength`/
 *   `resolveRange`/`cache`/`blockBytes`
 * @returns {Promise<{ pool: import('../pool.js').KernelPool, remoteFile: import('./remoteFile.js').RemoteFile,
 *   prefetch: (query: object) => Promise<void> }>}
 */
export async function openRemotePck(url, options = {}) {
  const remoteFile = await openRemoteFile(url, options);
  const pool = new KernelPool();
  return {
    pool,
    remoteFile,
    prefetch: (query) => prefetchPckQuery(remoteFile, pool, query),
  };
}
