/**
 * Parses the subset of SPICE's very permissive str2et_c input grammar
 * that spiceJS currently supports:
 *
 *   2000-01-01T12:00:00.500        ISO calendar, UTC by default
 *   2000-01-01 12:00:00
 *   2000-01-01
 *   2000 JAN 1 12:00:00            SPICE-style calendar, any field order
 *   1 JAN 2000 12:00:00
 *   JAN 1, 2000 12:00:00
 *   JD 2451545.0                   Julian date
 *   2000-01-01T12:00:00 TDB        explicit time system suffix
 *   JD 2451545.0 TDB
 *
 * Unsupported: day-of-year strings, spacecraft clock strings, and
 * anything requiring a kernel other than an LSK (e.g. TDT). These all
 * throw a descriptive Error rather than silently guessing.
 *
 * The result is `{ contSec, system }`:
 *  - `contSec` is continuous seconds past J2000 (see calendar.js) for
 *    calendar/ISO/JD inputs, computed purely from the clock digits in
 *    the string (no leapseconds kernel needed to get this far).
 *  - `system` is 'UTC' or 'TDB' and tells the caller whether
 *    `contSec` still needs the leapseconds correction (str2et.js).
 */
import { calendarToSeconds, monthNumber } from './calendar.js';

const SYSTEM_SUFFIX_RE = /\s+(UTC|TDB|TDT|ET)\s*$/i;
const ISO_RE =
  /^([+-]?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?$/;
const JD_RE = /^JD\s*([+-]?\d+(?:\.\d+)?)$/i;
const TIME_OF_DAY_RE = /(\d{1,2}):(\d{2})(?::(\d{1,2}(?:\.\d+)?))?/;
const MONTH_TOKEN_RE = /^[A-Za-z]{3,}$/;

function normalizeSystem(label) {
  const upper = label.toUpperCase();
  if (upper === 'ET') return 'TDB'; // SPICE's ET *is* TDB
  return upper;
}

/** Resolve a 2-digit year using SPICE's own 1969-2068 pivot convention. */
function expandTwoDigitYear(year) {
  return year <= 68 ? 2000 + year : 1900 + year;
}

export function parseTimeString(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError(`str2et: expected a string, got ${typeof raw}`);
  }
  let str = raw.trim();
  if (str.length === 0) {
    throw new Error('str2et: empty time string');
  }

  let system = 'UTC';
  const sysMatch = str.match(SYSTEM_SUFFIX_RE);
  if (sysMatch) {
    system = normalizeSystem(sysMatch[1]);
    str = str.slice(0, sysMatch.index).trim();
  }
  if (system === 'TDT') {
    throw new Error(`str2et: the TDT time system is not yet supported (in "${raw}")`);
  }

  const jdMatch = str.match(JD_RE);
  if (jdMatch) {
    const jd = Number(jdMatch[1]);
    return { contSec: (jd - 2451545.0) * 86400, system };
  }

  const isoMatch = str.match(ISO_RE);
  if (isoMatch) {
    const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = isoMatch;
    return {
      contSec: calendarToSeconds(Number(y), Number(mo), Number(d), Number(hh), Number(mi), Number(ss)),
      system,
    };
  }

  // Free-form calendar string: "YYYY MON DD [HH:MM:SS]", "DD MON YYYY [...]",
  // "MON DD, YYYY [...]" -- any order, as long as a month name is present.
  let hour = 0;
  let minute = 0;
  let second = 0;
  let datePart = str;
  const timeMatch = str.match(TIME_OF_DAY_RE);
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    second = timeMatch[3] !== undefined ? Number(timeMatch[3]) : 0;
    datePart = (str.slice(0, timeMatch.index) + ' ' + str.slice(timeMatch.index + timeMatch[0].length)).trim();
  }

  const tokens = datePart
    .replace(/,/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (tokens.length !== 3) {
    throw new Error(`str2et: unable to parse time string "${raw}"`);
  }

  const monthIdx = tokens.findIndex((t) => MONTH_TOKEN_RE.test(t));
  if (monthIdx === -1) {
    throw new Error(
      `str2et: unable to parse time string "${raw}" -- use an ISO date (YYYY-MM-DD) or ` +
        'include a month name (e.g. JAN)'
    );
  }
  const month = monthNumber(tokens[monthIdx]);
  const rest = tokens.filter((_, i) => i !== monthIdx);
  const [aTok, bTok] = rest;
  const a = Number(aTok);
  const b = Number(bTok);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new Error(`str2et: unable to parse time string "${raw}"`);
  }

  let year;
  let day;
  if (aTok.length === 4 || a > 31) {
    year = a;
    day = b;
  } else if (bTok.length === 4 || b > 31) {
    year = b;
    day = a;
  } else {
    throw new Error(
      `str2et: ambiguous date "${raw}" -- cannot tell which numeric field is the day and ` +
        'which is the year; use a 4-digit year'
    );
  }
  if (String(Math.trunc(year)).length <= 2) {
    year = expandTwoDigitYear(year);
  }

  return { contSec: calendarToSeconds(year, month, day, hour, minute, second), system };
}
