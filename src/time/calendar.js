/**
 * Calendar <-> continuous-seconds-past-J2000 conversions.
 *
 * "Continuous seconds past J2000" means: treat every calendar day as
 * exactly 86400 seconds and count elapsed seconds from the epoch
 * 2000-001-01T12:00:00 (JD 2451545.0), using the proleptic Gregorian
 * calendar. This is *not* a physical time scale by itself -- it is a
 * clock-face-to-number mapping. It becomes UTC, TAI, TT, or TDB
 * depending on how the leapseconds kernel's DELTA_AT table and the
 * DELTET periodic-term formula are applied on top of it (see
 * ../time/deltet.js).
 *
 * The DELTA_AT epochs stored in a leapseconds kernel (the `@1972-JAN-1`
 * style literals) are encoded with this same mapping, which is what
 * makes the bracket search in deltet.js meaningful.
 */

export const MONTH_NAMES = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

const J2000_JDN = 2451545;
const SECONDS_PER_DAY = 86400;

/**
 * Look up the 1-based month index (1-12) for a month name, matched on
 * its first three letters, case-insensitively.
 */
export function monthNumber(name) {
  const key = String(name).slice(0, 3).toUpperCase();
  const idx = MONTH_NAMES.indexOf(key);
  if (idx < 0) {
    throw new Error(`Unrecognized month name "${name}"`);
  }
  return idx + 1;
}

/**
 * Julian Day Number (integer, at noon) for a proleptic Gregorian
 * calendar date. Standard Fliegel & Van Flandern algorithm.
 */
function julianDayNumber(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** Inverse of julianDayNumber(): integer JDN -> {year, month, day}. */
function fromJulianDayNumber(jdn) {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

/**
 * Convert a proleptic-Gregorian calendar date/time to continuous
 * seconds past J2000 (see module doc comment).
 */
export function calendarToSeconds(year, month, day, hour = 0, minute = 0, second = 0) {
  const jdn = julianDayNumber(year, month, day);
  const dayFraction = (hour - 12) / 24 + minute / 1440 + second / SECONDS_PER_DAY;
  return (jdn - J2000_JDN + dayFraction) * SECONDS_PER_DAY;
}

/**
 * Inverse of calendarToSeconds(): continuous seconds past J2000 ->
 * {year, month, day, hour, minute, second}. `second` is fractional.
 */
export function secondsToCalendar(seconds) {
  const totalDays = seconds / SECONDS_PER_DAY + 0.5; // days past JDN=J2000_JDN at 0h
  let jdn = J2000_JDN + Math.floor(totalDays);
  let dayFraction = totalDays - Math.floor(totalDays); // [0, 1) past 0h of that JDN

  let secOfDay = dayFraction * SECONDS_PER_DAY;
  // Guard against floating point pushing us to (almost) the next day.
  const rounded = Math.round(secOfDay * 1e9) / 1e9;
  if (rounded >= SECONDS_PER_DAY) {
    secOfDay -= SECONDS_PER_DAY;
    jdn += 1;
  }

  const { year, month, day } = fromJulianDayNumber(jdn);
  const hour = Math.floor(secOfDay / 3600);
  const minute = Math.floor((secOfDay - hour * 3600) / 60);
  const second = secOfDay - hour * 3600 - minute * 60;
  return { year, month, day, hour, minute, second };
}

const AT_LITERAL_RE =
  /^@(-?\d{1,4})-([A-Za-z]{3}|\d{1,2})-(\d{1,2})(?:\/(\d{1,2}):(\d{2})(?::(\d{1,2}(?:\.\d+)?))?)?$/;

/**
 * Parse a SPICE text-kernel "@" date literal, e.g. `@1972-JAN-1` or
 * `@1986-01-18/12:00:00`, into continuous seconds past J2000.
 */
export function parseAtLiteral(token) {
  const m = AT_LITERAL_RE.exec(token);
  if (!m) {
    throw new Error(`Malformed "@" date literal: "${token}"`);
  }
  const year = Number(m[1]);
  const month = /^[A-Za-z]+$/.test(m[2]) ? monthNumber(m[2]) : Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] !== undefined ? Number(m[4]) : 0;
  const minute = m[5] !== undefined ? Number(m[5]) : 0;
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  return calendarToSeconds(year, month, day, hour, minute, second);
}
