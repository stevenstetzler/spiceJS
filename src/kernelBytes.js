/**
 * The environment-agnostic core of kernel loading: given bytes
 * already in memory and a name/key to register them under, sniff the
 * magic word and merge them into a kernel pool -- no filesystem, no
 * network, nothing Node- or browser-specific. This is what furnsh()
 * (src/kernels.js, Node `fs`-backed) and load() (src/load.js, URL/
 * File/bytes-backed) both build on, so the "what does this file's
 * magic word mean" logic exists exactly once.
 *
 * The one thing this module *can't* do itself is resolve and fetch a
 * meta-kernel's (KPL/MK) listed sub-kernels: turning a possibly-
 * relative reference into something loadable is environment-specific
 * (a local path needs Node's `path`; a URL needs the `URL`
 * constructor), and so is the actual I/O to load it (sync `fs`
 * reads vs. async `fetch`/cache). So for a meta-kernel, decodeKernel()
 * registers the meta-kernel itself (matching furnsh()'s existing
 * behavior: a meta-kernel is undoable, but has nothing of its own to
 * undo beyond its record in the registry) and hands back the *list*
 * of further references to load, leaving the resolve-and-recurse loop
 * to the caller.
 */
import { decodeLatin1, parseFileRecord } from './daf.js';
import { loadTextKernel } from './textKernel.js';
import { loadSpk } from './spk.js';
import { loadPck } from './pck.js';
import { loadCk } from './ck.js';
import { parseMetaKernel } from './metaKernel.js';
import { registryFor } from './kernelRegistry.js';

function firstLineOf(text) {
  const nl = text.indexOf('\n');
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

/**
 * @param {Uint8Array} bytes
 * @param {string} name - a path, URL, or other caller-chosen key this
 *   kernel is registered under (for unload()/kclear() bookkeeping,
 *   and to resolve a meta-kernel's relative sub-kernel references
 *   against).
 * @param {import('./pool.js').KernelPool} pool
 * @returns {{ isMeta: boolean, kernelsToLoad?: string[] }} for a
 *   meta-kernel, `kernelsToLoad` is the (symbol-substituted, still
 *   possibly relative) list of further references the caller must
 *   resolve and load itself; otherwise `isMeta` is false and there's
 *   nothing further to do.
 */
export function decodeKernel(bytes, name, pool) {
  const magic = decodeLatin1(bytes, 0, 8);

  if (magic.startsWith('KPL/')) {
    const content = new TextDecoder('utf-8').decode(bytes);
    const header = firstLineOf(content).toUpperCase();
    const subtype = header.slice(4).trim();
    if (subtype === 'MK') {
      const { kernelsToLoad } = parseMetaKernel(content);
      registryFor(pool).set(name, { type: 'meta' });
      return { isMeta: true, kernelsToLoad };
    }
    const changes = loadTextKernel(content, pool);
    registryFor(pool).set(name, { type: 'text', changes });
    return { isMeta: false };
  }

  if (magic.startsWith('DAF/SPK')) {
    const segments = loadSpk(bytes);
    pool.addSpkSegments(segments);
    registryFor(pool).set(name, { type: 'spk', segments });
    return { isMeta: false };
  }

  if (magic.startsWith('DAF/PCK')) {
    const segments = loadPck(bytes);
    pool.addPckSegments(segments);
    registryFor(pool).set(name, { type: 'pck', segments });
    return { isMeta: false };
  }

  if (magic.startsWith('DAF/CK')) {
    const segments = loadCk(bytes);
    pool.addCkSegments(segments);
    registryFor(pool).set(name, { type: 'ck', segments });
    return { isMeta: false };
  }

  // Older/generic SPK and PCK files (including several of NAIF's own
  // real, publicly distributed ones -- e.g. the DSN station-position
  // kernels) use the generic "NAIF/DAF" ID word instead of "DAF/SPK"/
  // "DAF/PCK". Real CSPICE still loads these as SPK/PCK data (confirmed
  // empirically against spiceypy), so route by the parsed summary
  // shape instead of the ID word text: SPK is ND=2,NI=6, PCK is
  // ND=2,NI=5. (CK also happens to be ND=2,NI=6, the same shape as SPK
  // -- shape alone can't tell them apart -- but a real CK file always
  // carries the type-specific "DAF/CK" word above; NAIF's own writers
  // never stamp a CK with the generic legacy word, so routing an
  // ND=2,NI=6 generic-word file to SPK here is the right call, not an
  // ambiguity actually reachable in practice.)
  if (magic.startsWith('NAIF/DAF')) {
    const { nd, ni } = parseFileRecord(bytes);
    if (nd === 2 && ni === 6) {
      const segments = loadSpk(bytes);
      pool.addSpkSegments(segments);
      registryFor(pool).set(name, { type: 'spk', segments });
      return { isMeta: false };
    }
    if (nd === 2 && ni === 5) {
      const segments = loadPck(bytes);
      pool.addPckSegments(segments);
      registryFor(pool).set(name, { type: 'pck', segments });
      return { isMeta: false };
    }
    throw new Error(
      `"${name}" is a generic binary DAF (ID word "${magic.trim()}") with summary shape ` +
        `ND=${nd}, NI=${ni}, which doesn't match a supported SPK (ND=2, NI=6) or PCK (ND=2, NI=5) shape.`
    );
  }

  if (magic.startsWith('DAF/')) {
    throw new Error(
      `"${name}" is a binary SPICE kernel (${magic.trim()}). Only binary SPK, PCK, and CK kernels ` +
        'are supported so far -- other binary kernels (DSK, ...) are not.'
    );
  }

  throw new Error(
    `"${name}" does not look like a recognized SPICE kernel (expected a text kernel ` +
      'starting with "KPL/", or a binary SPK/PCK kernel starting with "DAF/SPK"/"DAF/PCK").'
  );
}
