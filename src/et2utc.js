import { globalPool } from './pool.js';
import { etToUtc } from './time/deltet.js';
import { secondsToCalendar } from './time/calendar.js';

const MONTH_NAMES = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

function pad(n, width) {
  return String(Math.trunc(n)).padStart(width, '0');
}

/**
 * SPICE's ET2UTC, provided mostly as str2et()'s round-trip inverse
 * for testing/sanity-checking. Unlike the real et2utc_c this only
 * supports one output style ('ISOC': "YYYY-MM-DDTHH:MM:SS.###"), not
 * the full 'C'/'D'/'J'/'ISOD' family.
 *
 * @param {number} et - ephemeris time, TDB seconds past J2000
 * @param {number} [precision] - digits after the decimal point (default 3)
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {string}
 */
export function et2utc(et, precision = 3, pool = globalPool) {
  const contSec = etToUtc(et, pool);
  const { year, month, day, hour, minute, second } = secondsToCalendar(contSec);
  const secStr = second.toFixed(precision).padStart(precision > 0 ? precision + 3 : 2, '0');
  return `${year.toString().padStart(4, '0')}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(
    minute,
    2
  )}:${secStr}`;
}

/** Same conversion, formatted SPICE-calendar style: "2000 JAN 01 12:00:00.000". */
export function et2utcCalendar(et, precision = 3, pool = globalPool) {
  const contSec = etToUtc(et, pool);
  const { year, month, day, hour, minute, second } = secondsToCalendar(contSec);
  const secStr = second.toFixed(precision).padStart(precision > 0 ? precision + 3 : 2, '0');
  return `${year.toString().padStart(4, '0')} ${MONTH_NAMES[month - 1]} ${pad(day, 2)} ${pad(hour, 2)}:${pad(
    minute,
    2
  )}:${secStr}`;
}
