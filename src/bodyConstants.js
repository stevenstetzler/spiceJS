/**
 * Body-specific physical constants from a loaded text PCK (e.g.
 * `BODY399_RADII`, `BODY399_GM`) -- NAIF's `bodvcd_c`/`bodvrd_c`
 * unified into one function, since (unlike spkez/spkezr) there's no
 * multi-hop chaining involved that would justify separate ID- and
 * name-based entry points.
 */
import { bodyCode } from './bodies.js';
import { globalPool } from './pool.js';

/**
 * The values of `BODY<id>_<item>` from the kernel pool, where `id` is
 * `body` itself if it's already a NAIF integer ID, or its resolution
 * via `bodyCode()` if it's a name string (case-insensitive, e.g.
 * `'EARTH'`, `'earth'`, or a plain integer string).
 *
 * @param {number|string} body - a NAIF body ID, or a body name string
 * @param {string} item - the constant's name, e.g. `'RADII'`, `'GM'`,
 *   `'POLE_RA'` (see a loaded text PCK, e.g. pck00011.tpc, for what's
 *   available for a given body)
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number[]}
 */
export function bodyValues(body, item, pool = globalPool) {
  const id = typeof body === 'number' ? body : bodyCode(String(body), pool);
  const name = `BODY${id}_${item}`;
  const values = pool.getValues(name);
  if (!values) {
    throw new Error(`bodyValues: no ${name} in the kernel pool -- load a text PCK that defines it`);
  }
  return values.map(Number);
}
