/**
 * Body name <-> NAIF ID resolution (SPICE's bodn2c_c/bods2c_c and
 * bodc2n_c), built on NAIF's own built-in name table
 * (src/data/bodyIds.js, extracted from source -- see
 * scripts/extract-body-ids.mjs).
 */
import { BODY_IDS } from './data/bodyIds.js';
import { globalPool } from './pool.js';

/** Case-insensitive, internal-whitespace-collapsed, per NAIF's own matching rule. */
function normalize(name) {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

const BUILTIN_BY_NAME = new Map();
const BUILTIN_BY_CODE = new Map();
for (const [code, name] of BODY_IDS) {
  BUILTIN_BY_NAME.set(normalize(name), code);
  // First name wins for a given code, matching BODY_IDS' own declared
  // order (real SPICE reports one canonical name per ID via bodc2n_c
  // even though several names can map to the same code, e.g. Earth's
  // barycenter aliases above).
  if (!BUILTIN_BY_CODE.has(code)) BUILTIN_BY_CODE.set(code, name);
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

/**
 * Resolve a NAIF integer ID to its body name (SPICE's bodc2n_c) --
 * the reverse of bodyCode(). Unlike bodyCode(), this never throws: an
 * ID with no known name (a custom/unnamed body from a user-supplied
 * kernel, for instance) falls back to `Body <id>`, matching how NAIF's
 * own `brief` utility displays an unnamed body.
 *
 * Lookup order matches bodyCode()'s own priority: a kernel pool's
 * `NAIF_BODY_CODE`/`NAIF_BODY_NAME` variables are checked before the
 * ~692-entry built-in table.
 *
 * @param {number} id
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {string}
 */
export function bodyName(id, pool = globalPool) {
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new TypeError(`bodyName: expected a number, got ${typeof id}`);
  }

  const poolNames = pool.getValues('NAIF_BODY_NAME');
  const poolCodes = pool.getValues('NAIF_BODY_CODE');
  if (poolNames && poolCodes) {
    const idx = poolCodes.findIndex((c) => Number(c) === id);
    if (idx !== -1 && idx < poolNames.length) {
      return String(poolNames[idx]);
    }
  }

  if (BUILTIN_BY_CODE.has(id)) {
    return BUILTIN_BY_CODE.get(id);
  }

  return `Body ${id}`;
}
