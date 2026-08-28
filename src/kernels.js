/**
 * Kernel loading: SPICE's FURNSH / UNLOAD / KCLEAR, for text kernels
 * (LSK, FK, IK, SCLK), meta-kernels (MK), binary SPK (trajectory)
 * kernels, binary PCK (body orientation) kernels, and binary CK
 * (spacecraft/instrument orientation) kernels. DAS-based kernels (DSK)
 * are detected and rejected with a clear "not supported yet" error
 * rather than silently misbehaving.
 *
 * This is the Node-specific half of kernel loading: `furnsh()` reads
 * a local file synchronously via `fs.readFileSync` and resolves
 * meta-kernel references via Node's `path`. The actual magic-word
 * sniffing and pool merging is environment-agnostic (kernelBytes.js's
 * `decodeKernel()`), shared with `load.js`'s `load()` -- the async
 * sibling that accepts a URL/File/raw bytes instead of only a local
 * path, for browser/network use. See docs/browser-support.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { globalPool } from './pool.js';
import { decodeKernel } from './kernelBytes.js';
import { unloadKey, kclearPool } from './kernelRegistry.js';
import { isUrlReference } from './kernelReference.js';

/**
 * Load a kernel file, merging its contents into the kernel pool.
 * Text kernels (KPL/LSK, KPL/FK, ...) are parsed into pool variables;
 * meta-kernels (KPL/MK) are expanded and each listed kernel is loaded
 * in turn; binary SPK kernels (DAF/SPK) are decoded into segments
 * indexed by target body ID (see spkState()/spkSegments()).
 *
 * @param {string} filePath
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function furnsh(filePath, pool = globalPool) {
  const absPath = path.resolve(filePath);
  const bytes = fs.readFileSync(absPath);
  const result = decodeKernel(bytes, absPath, pool);

  if (result.isMeta) {
    const baseDir = path.dirname(absPath);
    for (const substituted of result.kernelsToLoad) {
      const resolved = path.isAbsolute(substituted) ? substituted : path.resolve(baseDir, substituted);
      furnsh(resolved, pool);
    }
  }
}

/**
 * Undo a furnsh() load: restores every pool variable that file
 * introduced or overwrote to its prior state, or removes the SPK
 * segments it added. A no-op if the file was never loaded, matching
 * SPICE's unload_c.
 *
 * @param {string} filePath
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function unload(filePath, pool = globalPool) {
  // A URL isn't a filesystem path -- path.resolve() would mangle it
  // into something unrelated to the key load() registered it under
  // (load() never runs a URL through path.resolve() -- see load.js).
  // Everything else is assumed to be what furnsh() itself would have
  // resolved it to. The actual undo logic (once the right key is
  // known) is environment-agnostic -- see kernelRegistry.js's
  // unloadKey(), shared with browser.js's own unload().
  const absPath = isUrlReference(filePath) ? filePath : path.resolve(filePath);
  unloadKey(absPath, pool);
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
