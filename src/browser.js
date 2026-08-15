/**
 * The browser-safe entry point: everything spicejs's default entry
 * (index.js) exports *except* `furnsh()`, which is inherently
 * Node-only (`fs.readFileSync`, synchronous). Import from here (a
 * bundler resolves it automatically via package.json's `exports`
 * "browser" condition -- see below) to get a build with zero
 * `node:fs`/`node:path` references, verified with a real
 * `esbuild --platform=browser` bundle, not just by inspection: an
 * app that imports `load`/`unload`/`kclear` etc. from `index.js`
 * instead still pulls in `node:fs`/`node:path` at bundle time even if
 * `furnsh()` itself is never called, because a bundler has to
 * statically resolve every import reachable from a barrel file's
 * re-exports before it can tree-shake anything -- see
 * docs/browser-support.md §7 (bundle/package shape) for the full
 * story.
 *
 * `unload()`/`kclear()` here are *not* re-exports of kernels.js's --
 * they're their own thin wrappers around kernelRegistry.js's
 * environment-agnostic `unloadKey()`/`kclearPool()` (the same undo
 * logic kernels.js's own `unload()`/`kclear()` use), just without
 * kernels.js's Node-only `path.resolve()` step for local-path keys --
 * meaningless here anyway, since there's no `furnsh()`-style local
 * filesystem convention in a browser: every key `unload()` needs to
 * match here is exactly whatever `load()` itself registered it under
 * (a URL string, or the literal `'<bytes>'` placeholder for a
 * File/Blob/raw-bytes load -- see load.js).
 */
import { unloadKey, kclearPool } from './kernelRegistry.js';
import { globalPool } from './pool.js';

export { KernelPool, globalPool } from './pool.js';
export { load } from './load.js';
export { createMemoryCache, createIndexedDbCache } from './cache.js';
export { str2et } from './str2et.js';
export { et2utc, et2utcCalendar } from './et2utc.js';
export { spkState, spkSegments, spkez, spkezr } from './spk.js';
export { pckSegments } from './pck.js';
export { bodyCode } from './bodies.js';
export { bodyValues } from './bodyConstants.js';
export { prop2b } from './prop2b.js';
export { frameId } from './frames.js';

/**
 * Undo a load() call: restores every pool variable that reference
 * introduced or overwrote to its prior state, or removes the SPK/PCK
 * segments it added. A no-op if the reference was never loaded,
 * matching SPICE's unload_c (and kernels.js's own unload()).
 *
 * @param {string} reference - exactly what was passed to load()
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function unload(reference, pool = globalPool) {
  unloadKey(reference, pool);
}

/**
 * Clear the kernel pool entirely and forget all load history, as in
 * SPICE's kclear_c.
 *
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function kclear(pool = globalPool) {
  kclearPool(pool);
}
