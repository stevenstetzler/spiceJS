import { globalPool } from './pool.js';
import { etToTai } from './time/deltet.js';
import { secondsToCalendar } from './time/calendar.js';

const MONTH_NAMES = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

function pad(n, width) {
  return String(Math.trunc(n)).padStart(width, '0');
}

/**
 * et2utc()'s TAI-timescale sibling -- there is no real et2tai_c in
 * CSPICE (the equivalent call is unitim_c(et, 'ET', 'TAI') followed by
 * your own formatting), but the shape here matches et2utc.js exactly
 * so callers that need "the same epoch, just read on a TAI clock
 * instead of a UTC one" (e.g. a UI's UTC/TAI timescale toggle) have a
 * drop-in equivalent. Only the 'ISOC' output style, same as et2utc().
 *
 * @param {number} et - ephemeris time, TDB seconds past J2000
 * @param {number} [precision] - digits after the decimal point (default 3)
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {string}
 */
export function et2tai(et, precision = 3, pool = globalPool) {
  const contSec = etToTai(et, pool);
  const { year, month, day, hour, minute, second } = secondsToCalendar(contSec);
  const secStr = second.toFixed(precision).padStart(precision > 0 ? precision + 3 : 2, '0');
  return `${year.toString().padStart(4, '0')}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(
    minute,
    2
  )}:${secStr}`;
}

/** Same conversion, formatted SPICE-calendar style: "2000 JAN 01 12:00:00.000". */
export function et2taiCalendar(et, precision = 3, pool = globalPool) {
  const contSec = etToTai(et, pool);
  const { year, month, day, hour, minute, second } = secondsToCalendar(contSec);
  const secStr = second.toFixed(precision).padStart(precision > 0 ? precision + 3 : 2, '0');
  return `${year.toString().padStart(4, '0')} ${MONTH_NAMES[month - 1]} ${pad(day, 2)} ${pad(hour, 2)}:${pad(
    minute,
    2
  )}:${secStr}`;
}
