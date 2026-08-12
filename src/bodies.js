/**
 * Body name <-> NAIF ID resolution (SPICE's bodn2c_c/bods2c_c), built
 * on NAIF's own built-in name table (src/data/bodyIds.js, extracted
 * from source -- see scripts/extract-body-ids.mjs).
 */
import { BODY_IDS } from './data/bodyIds.js';
import { globalPool } from './pool.js';

/** Case-insensitive, internal-whitespace-collapsed, per NAIF's own matching rule. */
function normalize(name) {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

const BUILTIN_BY_NAME = new Map();
for (const [code, name] of BODY_IDS) {
  BUILTIN_BY_NAME.set(normalize(name), code);
}

/**
 * Resolve a body name (or a plain integer ID given as a string) to
 * its NAIF integer ID.
 *
 * Lookup order matches real SPICE's priority: a kernel pool's
 * `NAIF_BODY_NAME`/`NAIF_BODY_CODE` variables (typically loaded from
 * a frame kernel, letting users add or override names) are checked
 * before the ~692-entry built-in table.
 *
 * @param {string} name
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number}
 */
export function bodyCode(name, pool = globalPool) {
  if (typeof name !== 'string') {
    throw new TypeError(`bodyCode: expected a string, got ${typeof name}`);
  }
  const trimmed = name.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const key = normalize(trimmed);
  const poolNames = pool.getValues('NAIF_BODY_NAME');
  const poolCodes = pool.getValues('NAIF_BODY_CODE');
  if (poolNames && poolCodes) {
    const idx = poolNames.findIndex((n) => normalize(String(n)) === key);
    if (idx !== -1 && idx < poolCodes.length) {
      return Number(poolCodes[idx]);
    }
  }

  if (BUILTIN_BY_NAME.has(key)) {
    return BUILTIN_BY_NAME.get(key);
  }

  throw new Error(`bodyCode: unrecognized body name "${name}"`);
}
