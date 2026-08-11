import { globalPool } from './pool.js';
import { parseTimeString } from './time/parseTimeString.js';
import { utcToEt } from './time/deltet.js';

/**
 * SPICE's STR2ET: convert a time string to ephemeris time (ET, i.e.
 * TDB seconds past J2000).
 *
 * UTC calendar/Julian-date strings (the default when no time system
 * is specified) require a leapseconds kernel to have been loaded into
 * the pool with furnsh() first. Strings explicitly labeled "TDB" (or
 * "ET") need no kernel at all, since ET *is* TDB in SPICE.
 *
 * @param {string} timeString
 * @param {import('./pool.js').KernelPool} [pool] - defaults to the
 *   shared global kernel pool used by furnsh().
 * @returns {number} ephemeris time, TDB seconds past J2000
 */
export function str2et(timeString, pool = globalPool) {
  const { contSec, system } = parseTimeString(timeString);
  if (system === 'TDB') {
    return contSec;
  }
  return utcToEt(contSec, pool);
}
