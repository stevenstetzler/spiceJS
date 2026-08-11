/**
 * Parses time strings the way SPICE's str2et_c does (per its
 * documentation: https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/
 * FORTRAN/spicelib/str2et.html, and the same rules restated in
 * tparse_c's header). Supported:
 *
 *   ISO ("T") formats
 *     1996-12-18T12:28:28, 1986-01-18T12, 1986-01-18T12:19:52.18Z
 *     1995-08T18:28:12       (2 dash fields -> Year + Day-of-Year)
 *     1995-18T, 0000-01-01T  (truncated / year-zero -> 1 BC)
 *
 *   Calendar formats, any field order, month given by name
 *     1 DEC 1997 12:28:29.192, Mar 2 12:18:17.287 1993,
 *     1972 27 jun 12:29, 17JUN1982 18:28:28 (letters need not be
 *     delimited from digits), Tue Aug 6 11:10:57 1996 (weekday
 *     ignored), '93 Jan 23 ... (quoted 2-digit year),
 *     23 A.D. APR 4 ..., 18 B.C. Jun 3 ... (era)
 *
 *   Slash-delimited numeric calendar dates (Month/Day/Year assumed)
 *     2/3/1996 17:18:12.002, 1978/3/12 23:28:59.29
 *
 *   Day-of-year formats (a dash-separated Year/DOY pair plus a "//"
 *   or "::" -- or, per NAIF's own examples, a single "/" -- marker,
 *   with the time-of-day either trailing or leading)
 *     1997-162::12:18:28.827, 162-1996/12:28:28.287
 *     17:28:01.287 1992-272//
 *
 *   Julian date (the substring "JD"/"jd" may appear before or after
 *   the number, optionally parenthesized)
 *     jd 28272.291, 2451515.2981 (JD), 2451515.2981 JD
 *
 *   Time system / zone labels
 *     ... TDB, ... TDT (rejected -- see below), ... UTC
 *     ... A.M. / P.M.
 *     ... EST/EDT/CST/CDT/MST/MDT/PST/PDT, ... UTC+5:30
 *
 * Not supported (all fail with a descriptive Error rather than a
 * silent wrong answer): the TDT time system, and any string ambiguous
 * enough that NAIF's own rules don't resolve it either.
 *
 * The result is `{ contSec, system }`: `contSec` is continuous
 * seconds past J2000 (see calendar.js), already adjusted for any
 * time zone offset so it is in UTC or TDB terms; `system` is 'UTC' or
 * 'TDB' and tells the caller (str2et.js) whether `contSec` still
 * needs the leapseconds correction.
 */
import { calendarToSeconds, monthNumber } from './calendar.js';

const WEEKDAY_RE = /^(SUN|MON|TUE|WED|THU|FRI|SAT)[A-Za-z]*\.?,?\s+/i;
const UTC_OFFSET_RE = /\bUTC\s*([+-])\s*(\d{1,2})(?::(\d{2}))?\b/i;
const NAMED_TZ_RE = /\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/i;
const SYSTEM_RE = /\b(TDB|TDT|UTC|ET)\b/i;
const AMPM_RE = /\b([AP])\.?M\.?\b/i;
const ERA_RE = /(\d{1,4})\s*(B\.?C\.?|A\.?D\.?)\b/i;
const JD_WORD_RE = /\bJD\b/i;
const QUOTED_YEAR_RE = /'(\d{1,2})\b/;

const NAMED_TZ_OFFSET_HOURS = {
  EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7,
};

const TIME_OF_DAY_RE = /(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/;

// Full-date ISO (3 dash fields: year-month-day) or ordinal ISO
// (2 dash fields: year-dayOfYear), with an optional T-introduced time
// of any precision and an optional trailing Z.
const ISO_RE =
  /^([+-]?\d{1,4})-(\d{1,3})(?:-(\d{1,2}))?(?:[T ](\d{1,2})?(?::(\d{1,2}))?(?::(\d{1,2}(?:\.\d+)?))?)?Z?$/i;

// Year/day-of-year pair (dash- or space-separated), terminated by
// NAIF's day-of-year marker. The documented marker is "//" or "::";
// NAIF's own examples also accept a single "/", so both are honored
// here, with the time-of-day optionally trailing after the marker.
const DOY_RE =
  /^('?)(\d{1,4})[\s-]('?)(\d{1,4})(?:\/\/?|::)\s*(?:(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?$/;

// Same Year/DOY-pair-plus-marker format, but with the time-of-day
// leading instead of trailing -- NAIF's own examples include both
// orderings (e.g. "17:28:01.287 1992-272//").
const DOY_TIME_FIRST_RE =
  /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s+('?)(\d{1,4})[\s-]('?)(\d{1,4})(?:\/\/?|::)\s*$/;

// Month/Day/Year, all slash-separated, no month name.
const SLASH_MDY_RE =
  /^('?)(\d{1,4})\/('?)(\d{1,4})\/('?)(\d{1,4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?$/;

function expandTwoDigitYear(year) {
  return year <= 68 ? 2000 + year : 1900 + year;
}

/**
 * Apply NAIF's 2-digit year abbreviation pivot whenever it applies --
 * regardless of whether the year was quoted. Only plain 0-99 values
 * are eligible; era-derived (B.C./A.D.) years are never pivoted and
 * should not be passed through this function at all.
 */
function normalizeYear(year) {
  const truncated = Math.trunc(year);
  return truncated >= 0 && truncated <= 99 ? expandTwoDigitYear(truncated) : year;
}

/**
 * Resolve which of a Year/DOY pair is the year: a quoted number wins,
 * then whichever is > 999 (rule 14), else NAIF's documented default
 * of "the first integer is the year" when neither clue applies.
 */
function resolveYearDoy(q1, n1, q2, n2) {
  if (q1) return { year: n1, doy: n2 };
  if (q2) return { year: n2, doy: n1 };
  if (n1 > 999) return { year: n1, doy: n2 };
  if (n2 > 999) return { year: n2, doy: n1 };
  return { year: n1, doy: n2 };
}

function applyAmPm(hour, ampm) {
  if (!ampm) return hour;
  if (hour < 1 || hour > 12) {
    throw new RangeError('str2et: hours must be between 1 and 12 when A.M./P.M. is specified');
  }
  if (ampm === 'AM') return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

/** Extract `re`'s first match from `str`, returning [matchOrNull, remainingStr]. */
function extract(str, re) {
  const m = str.match(re);
  if (!m) return [null, str];
  return [m, (str.slice(0, m.index) + ' ' + str.slice(m.index + m[0].length)).trim()];
}

export function parseTimeString(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError(`str2et: expected a string, got ${typeof raw}`);
  }
  let str = raw.trim();
  if (str.length === 0) {
    throw new Error('str2et: empty time string');
  }

  let tzOffsetHours = 0;
  let m;

  [m, str] = extract(str, UTC_OFFSET_RE);
  if (m) tzOffsetHours = (m[1] === '-' ? -1 : 1) * (Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0));

  if (!m) {
    [m, str] = extract(str, NAMED_TZ_RE);
    if (m) tzOffsetHours = NAMED_TZ_OFFSET_HOURS[m[1].toUpperCase()];
  }

  let system = 'UTC';
  [m, str] = extract(str, SYSTEM_RE);
  if (m) {
    const label = m[1].toUpperCase();
    system = label === 'ET' ? 'TDB' : label;
  }
  if (system === 'TDT') {
    throw new Error(`str2et: the TDT time system is not yet supported (in "${raw}")`);
  }
  if (tzOffsetHours !== 0 && system !== 'UTC') {
    throw new Error(`str2et: a time zone cannot be combined with the ${system} time system (in "${raw}")`);
  }

  let ampm = null;
  [m, str] = extract(str, AMPM_RE);
  if (m) ampm = m[1].toUpperCase() === 'A' ? 'AM' : 'PM';

  // An era immediately following a year: resolve it to a signed,
  // astronomical-numbered year up front (bypassing the usual 2-digit
  // pivot -- "23 A.D." means the year 23, not 2023) and drop the
  // whole "<year> B.C./A.D." substring from further consideration.
  let explicitYear = null;
  const eraMatch = str.match(ERA_RE);
  if (eraMatch) {
    const isBc = eraMatch[2].toUpperCase().startsWith('B');
    explicitYear = isBc ? 1 - Number(eraMatch[1]) : Number(eraMatch[1]);
    str = (str.slice(0, eraMatch.index) + ' ' + str.slice(eraMatch.index + eraMatch[0].length)).trim();
  }

  str = str.replace(WEEKDAY_RE, '').trim();
  if (str.length === 0) {
    throw new Error(`str2et: unable to parse time string "${raw}"`);
  }

  const finish = (contSecLocal) => ({
    contSec: tzOffsetHours ? contSecLocal - tzOffsetHours * 3600 : contSecLocal,
    system,
  });

  // --- Julian date: "JD"/"jd" may appear before or after the number ---
  if (JD_WORD_RE.test(str)) {
    const numStr = str.replace(JD_WORD_RE, ' ').replace(/[()]/g, ' ').trim();
    const jd = Number(numStr);
    if (numStr === '' || Number.isNaN(jd)) {
      throw new Error(`str2et: unable to parse Julian date string "${raw}"`);
    }
    return finish((jd - 2451545.0) * 86400);
  }

  // --- ISO calendar / ordinal-day formats ---
  m = str.match(ISO_RE);
  if (m) {
    const year = Number(m[1]);
    const hour = applyAmPm(m[4] !== undefined ? Number(m[4]) : 0, ampm);
    const minute = m[5] !== undefined ? Number(m[5]) : 0;
    const second = m[6] !== undefined ? Number(m[6]) : 0;
    if (m[3] !== undefined) {
      // Year-Month-Day
      return finish(calendarToSeconds(year, Number(m[2]), Number(m[3]), hour, minute, second));
    }
    // Year-DayOfYear (no month/day field)
    const doy = Number(m[2]);
    return finish(calendarToSeconds(year, 1, 1, hour, minute, second) + (doy - 1) * 86400);
  }

  // --- Day-of-year with a dash-separated Year/DOY pair + // or :: marker ---
  m = str.match(DOY_RE);
  if (m) {
    const [, q1, n1Str, q2, n2Str, hh, mi, ss] = m;
    let { year, doy } = resolveYearDoy(q1, Number(n1Str), q2, Number(n2Str));
    year = normalizeYear(year);
    const hour = applyAmPm(hh !== undefined ? Number(hh) : 0, ampm);
    const minute = mi !== undefined ? Number(mi) : 0;
    const second = ss !== undefined ? Number(ss) : 0;
    return finish(calendarToSeconds(year, 1, 1, hour, minute, second) + (doy - 1) * 86400);
  }

  // --- Same format, with the time-of-day leading instead of trailing ---
  m = str.match(DOY_TIME_FIRST_RE);
  if (m) {
    const [, hh, mi, ss, q1, n1Str, q2, n2Str] = m;
    let { year, doy } = resolveYearDoy(q1, Number(n1Str), q2, Number(n2Str));
    year = normalizeYear(year);
    const hour = applyAmPm(Number(hh), ampm);
    const minute = Number(mi);
    const second = ss !== undefined ? Number(ss) : 0;
    return finish(calendarToSeconds(year, 1, 1, hour, minute, second) + (doy - 1) * 86400);
  }

  // --- Slash-delimited numeric Month/Day/Year ---
  m = str.match(SLASH_MDY_RE);
  if (m) {
    const [, q1, n1Str, q2, n2Str, q3, n3Str, hh, mi, ss] = m;
    const nums = [Number(n1Str), Number(n2Str), Number(n3Str)];
    const quoted = [Boolean(q1), Boolean(q2), Boolean(q3)];
    let yearIdx = quoted.findIndex(Boolean);
    if (yearIdx === -1) yearIdx = nums.findIndex((n) => n > 999);
    if (yearIdx === -1) yearIdx = 2; // default: Month/Day/Year
    const [month, day] = nums.filter((_, i) => i !== yearIdx);
    const year = normalizeYear(nums[yearIdx]);
    const hour = applyAmPm(hh !== undefined ? Number(hh) : 0, ampm);
    const minute = mi !== undefined ? Number(mi) : 0;
    const second = ss !== undefined ? Number(ss) : 0;
    return finish(calendarToSeconds(year, month, day, hour, minute, second));
  }

  // --- Free-form calendar string with a month name, any field order ---
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
  hour = applyAmPm(hour, ampm);

  const quotedYearMatch = datePart.match(QUOTED_YEAR_RE);
  const quotedYearValue = quotedYearMatch ? Number(quotedYearMatch[1]) : null;

  // Tokenize into letter-runs and digit-runs -- this also splits
  // undelimited forms like "17JUN1982" at the letter/digit boundary.
  const tokens = datePart.match(/[A-Za-z]+|\d+(?:\.\d+)?/g) || [];
  const monthIdx = tokens.findIndex((t) => /^[A-Za-z]{3,}$/.test(t));
  if (monthIdx === -1) {
    throw new Error(
      `str2et: unable to parse time string "${raw}" -- use an ISO date (YYYY-MM-DD), a Julian date ` +
        '("JD ...") or include a month name (e.g. JAN)'
    );
  }
  const month = monthNumber(tokens[monthIdx]);
  const numTokens = tokens.filter((_, i) => i !== monthIdx).map(Number);

  let year;
  let day;
  if (explicitYear !== null) {
    // The year was already resolved via a B.C./A.D. era marker; only
    // a day number is left to find, and it is never pivoted.
    if (numTokens.length !== 1 || Number.isNaN(numTokens[0])) {
      throw new Error(`str2et: unable to parse time string "${raw}"`);
    }
    year = explicitYear;
    [day] = numTokens;
  } else {
    if (numTokens.length !== 2 || numTokens.some(Number.isNaN)) {
      throw new Error(`str2et: unable to parse time string "${raw}"`);
    }
    const [a, b] = numTokens;
    if (quotedYearValue !== null && (a === quotedYearValue || b === quotedYearValue)) {
      [year, day] = a === quotedYearValue ? [a, b] : [b, a];
    } else if (a > 999) {
      [year, day] = [a, b];
    } else if (b > 999) {
      [year, day] = [b, a];
    } else if (monthIdx === 0) {
      // Month Day Year
      [day, year] = [a, b];
    } else {
      // Year Month Day  (monthIdx === 1)   or   Year Day Month  (monthIdx === 2)
      [year, day] = [a, b];
    }
    year = normalizeYear(year);
  }

  return finish(calendarToSeconds(year, month, day, hour, minute, second));
}
