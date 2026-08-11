/**
 * Kernel loading: SPICE's FURNSH / UNLOAD / KCLEAR, for text kernels
 * (LSK, FK, IK, SCLK) and meta-kernels (MK). Binary kernels (SPK, CK,
 * PCK, ...) are detected and rejected with a clear "not supported
 * yet" error rather than silently misbehaving.
 */
import fs from 'node:fs';
import path from 'node:path';
import { globalPool, KernelPool } from './pool.js';
import { loadTextKernel } from './textKernel.js';

// Per-pool record of what furnsh() loaded from each file, so unload()
// can undo it. Keyed by pool identity so isolated pools (e.g. in
// tests) don't share load history.
const registries = new WeakMap();

function registryFor(pool) {
  let registry = registries.get(pool);
  if (!registry) {
    registry = new Map();
    registries.set(pool, registry);
  }
  return registry;
}

function firstLineOf(content) {
  const nl = content.indexOf('\n');
  return (nl === -1 ? content : content.slice(0, nl)).trim();
}

function substitutePathSymbols(kernelPath, symbolMap) {
  return kernelPath.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (whole, symbol) =>
    symbolMap.has(symbol) ? symbolMap.get(symbol) : whole
  );
}

function loadMetaKernel(content, absPath, pool) {
  // A meta-kernel's own PATH_SYMBOLS/PATH_VALUES/KERNELS_TO_LOAD
  // variables are scratch data, not meant to land in the real kernel
  // pool -- parse them into a throwaway pool instead.
  const scratch = new KernelPool();
  loadTextKernel(content, scratch);

  const symbols = scratch.getValues('PATH_SYMBOLS') || [];
  const values = scratch.getValues('PATH_VALUES') || [];
  const symbolMap = new Map(symbols.map((s, i) => [s, values[i]]));
  const kernelsToLoad = scratch.getValues('KERNELS_TO_LOAD') || [];

  const baseDir = path.dirname(absPath);
  for (const rawPath of kernelsToLoad) {
    const substituted = substitutePathSymbols(String(rawPath), symbolMap);
    const resolved = path.isAbsolute(substituted) ? substituted : path.resolve(baseDir, substituted);
    furnsh(resolved, pool);
  }
  // Record the meta-kernel itself as loaded (with no direct pool
  // changes of its own) so a repeat/duplicate furnsh() and unload()
  // of the .tm file behave sensibly.
  registryFor(pool).set(absPath, []);
}

/**
 * Load a kernel file, merging its contents into the kernel pool (as
 * SPICE's furnsh_c does for text kernels). Meta-kernels (KPL/MK) are
 * expanded and each listed kernel is loaded in turn.
 *
 * @param {string} filePath
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function furnsh(filePath, pool = globalPool) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, 'utf8');
  const header = firstLineOf(content).toUpperCase();

  if (header.startsWith('KPL/')) {
    const subtype = header.slice(4).trim();
    if (subtype === 'MK') {
      loadMetaKernel(content, absPath, pool);
      return;
    }
    const changes = loadTextKernel(content, pool);
    registryFor(pool).set(absPath, changes);
    return;
  }

  if (header.startsWith('DAF/') || header.startsWith('NAIF/DAF')) {
    throw new Error(
      `furnsh: "${filePath}" is a binary SPICE kernel (${header.split(/\s+/)[0]}). Binary kernels ` +
        '(SPK, PCK, CK, ...) are not supported yet by spiceJS -- only text kernels (LSK, FK, IK, ' +
        'SCLK) and meta-kernels can currently be loaded.'
    );
  }

  throw new Error(
    `furnsh: "${filePath}" does not look like a recognized SPICE kernel (expected a text kernel ` +
      'starting with "KPL/").'
  );
}

/**
 * Undo a furnsh() load: restores every pool variable that file
 * introduced or overwrote to its prior state. A no-op if the file was
 * never loaded, matching SPICE's unload_c.
 *
 * @param {string} filePath
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function unload(filePath, pool = globalPool) {
  const absPath = path.resolve(filePath);
  const registry = registryFor(pool);
  const changes = registry.get(absPath);
  if (!changes) return;
  for (const { name, hadPrevious, previousValue } of [...changes].reverse()) {
    if (hadPrevious) {
      pool.putValues(name, previousValue, false);
    } else {
      pool.deleteVar(name);
    }
  }
  registry.delete(absPath);
}

/**
 * Clear the kernel pool entirely and forget all load history, as in
 * SPICE's kclear_c.
 *
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function kclear(pool = globalPool) {
  pool.clear();
  registryFor(pool).clear();
}
