/**
 * Kernel loading: SPICE's FURNSH / UNLOAD / KCLEAR, for text kernels
 * (LSK, FK, IK, SCLK), meta-kernels (MK), binary SPK (trajectory)
 * kernels, and binary PCK (body orientation) kernels. Other binary
 * kernels (CK) and DAS-based kernels (DSK) are detected and rejected
 * with a clear "not supported yet" error rather than silently
 * misbehaving.
 */
import fs from 'node:fs';
import path from 'node:path';
import { globalPool, KernelPool } from './pool.js';
import { loadTextKernel } from './textKernel.js';
import { loadSpk } from './spk.js';
import { loadPck } from './pck.js';

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

function firstLineOf(text) {
  const nl = text.indexOf('\n');
  return (nl === -1 ? text : text.slice(0, nl)).trim();
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
  // Record the meta-kernel itself as loaded (with nothing of its own
  // to undo) so a repeat/duplicate furnsh() and unload() of the .tm
  // file behave sensibly. The kernels it expanded to were furnsh'd
  // (and are unloaded) individually.
  registryFor(pool).set(absPath, { type: 'meta' });
}

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
  const buffer = fs.readFileSync(absPath);
  const magic = buffer.toString('latin1', 0, 8);

  if (magic.startsWith('KPL/')) {
    const content = buffer.toString('utf8');
    const header = firstLineOf(content).toUpperCase();
    const subtype = header.slice(4).trim();
    if (subtype === 'MK') {
      loadMetaKernel(content, absPath, pool);
      return;
    }
    const changes = loadTextKernel(content, pool);
    registryFor(pool).set(absPath, { type: 'text', changes });
    return;
  }

  if (magic.startsWith('DAF/SPK')) {
    const segments = loadSpk(buffer);
    pool.addSpkSegments(segments);
    registryFor(pool).set(absPath, { type: 'spk', segments });
    return;
  }

  if (magic.startsWith('DAF/PCK')) {
    const segments = loadPck(buffer);
    pool.addPckSegments(segments);
    registryFor(pool).set(absPath, { type: 'pck', segments });
    return;
  }

  if (magic.startsWith('DAF/') || magic.startsWith('NAIF/DAF')) {
    throw new Error(
      `furnsh: "${filePath}" is a binary SPICE kernel (${magic.trim()}). Only binary SPK and PCK kernels ` +
        'are supported so far -- other binary kernels (CK, ...) are not.'
    );
  }

  throw new Error(
    `furnsh: "${filePath}" does not look like a recognized SPICE kernel (expected a text kernel ` +
      'starting with "KPL/", or a binary SPK/PCK kernel starting with "DAF/SPK"/"DAF/PCK").'
  );
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
  const absPath = path.resolve(filePath);
  const registry = registryFor(pool);
  const entry = registry.get(absPath);
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
  }
  // 'meta' entries have nothing of their own to undo.

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
