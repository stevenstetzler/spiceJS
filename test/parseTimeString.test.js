import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeString } from '../src/time/parseTimeString.js';
import { calendarToSeconds } from '../src/time/calendar.js';

const J2000_NOON = calendarToSeconds(2000, 1, 1, 12, 0, 0);

function expectCalendar(input, [y, mo, d, h, mi, s], system = 'UTC') {
  const result = parseTimeString(input);
  assert.equal(result.system, system, `system for "${input}"`);
  assert.ok(
    Math.abs(result.contSec - calendarToSeconds(y, mo, d, h, mi, s)) < 1e-6,
    `contSec for "${input}": got ${result.contSec}, expected ${calendarToSeconds(y, mo, d, h, mi, s)}`
  );
}

/** Like expectCalendar, but the expectation is given as year + day-of-year. */
function expectDoy(input, year, doy, [h, mi, s], system = 'UTC') {
  const result = parseTimeString(input);
  const expected = calendarToSeconds(year, 1, 1, h, mi, s) + (doy - 1) * 86400;
  assert.equal(result.system, system, `system for "${input}"`);
  assert.ok(
    Math.abs(result.contSec - expected) < 1e-6,
    `contSec for "${input}": got ${result.contSec}, expected ${expected} (year ${year}, DOY ${doy})`
  );
}

test('ISO calendar strings default to UTC', () => {
  assert.deepEqual(parseTimeString('2000-01-01T12:00:00'), { contSec: J2000_NOON, system: 'UTC' });
  assert.deepEqual(parseTimeString('2000-01-01 12:00:00'), { contSec: J2000_NOON, system: 'UTC' });
});

test('ISO date with no time-of-day defaults to midnight', () => {
  const { contSec, system } = parseTimeString('2000-01-02');
  assert.equal(system, 'UTC');
  assert.equal(contSec, calendarToSeconds(2000, 1, 2, 0, 0, 0));
});

test('explicit TDB/ET suffix is recognized and passed through unchanged', () => {
  assert.deepEqual(parseTimeString('2000-01-01T12:00:00 TDB'), { contSec: J2000_NOON, system: 'TDB' });
  assert.deepEqual(parseTimeString('2000-01-01T12:00:00 ET'), { contSec: J2000_NOON, system: 'TDB' });
});

test('rejects the unsupported TDT system', () => {
  assert.throws(() => parseTimeString('2000-01-01T12:00:00 TDT'), /TDT/);
});

test('rejects free-form dates with no month name at all', () => {
  assert.throws(() => parseTimeString('01 02 03'), /include a month name/);
});

test('rejects unparseable strings', () => {
  assert.throws(() => parseTimeString('not a time'));
  assert.throws(() => parseTimeString(''));
});

// ---------------------------------------------------------------------
// Everything below is transcribed directly from NAIF's own str2et_c
// documentation examples:
// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/str2et_c.html
// (mirrored at https://github.com/OpenSpace/Spice, src/common/str2et_c.c)
// so this is a regression test against NAIF's documented behavior, not
// just our own expectations. Two rows from that table are omitted as
// apparent documentation typos (noted below) rather than bugs to match.
// ---------------------------------------------------------------------

test('ISO (T) format examples from the str2et_c documentation', () => {
  expectCalendar('1996-12-18T12:28:28', [1996, 12, 18, 12, 28, 28]);
  expectCalendar('1986-01-18T12', [1986, 1, 18, 12, 0, 0]);
  expectCalendar('1986-01-18T12:19', [1986, 1, 18, 12, 19, 0]);
  expectCalendar('1986-01-18T12:19:52.18', [1986, 1, 18, 12, 19, 52.18]);
  expectCalendar('1986-01-18T12:19:52.18Z', [1986, 1, 18, 12, 19, 52.18]);
  expectDoy('1995-08T18:28:12', 1995, 8, [18, 28, 12]);
  expectDoy('1995-08T18:28:12Z', 1995, 8, [18, 28, 12]);
  expectDoy('1995-18T', 1995, 18, [0, 0, 0]);
  expectCalendar('0000-01-01T', [0, 1, 1, 0, 0, 0]); // astronomical year 0 == 1 B.C.
});

test('calendar format examples from the str2et_c documentation', () => {
  expectCalendar('Tue Aug  6 11:10:57  1996', [1996, 8, 6, 11, 10, 57]);
  expectCalendar('1 DEC 1997 12:28:29.192', [1997, 12, 1, 12, 28, 29.192]);
  expectCalendar('2/3/1996 17:18:12.002', [1996, 2, 3, 17, 18, 12.002]);
  expectCalendar('Mar 2 12:18:17.287 1993', [1993, 3, 2, 12, 18, 17.287]);
  expectCalendar('1992 11:18:28  3 Jul', [1992, 7, 3, 11, 18, 28]);
  expectCalendar('June 12, 1989 01:21', [1989, 6, 12, 1, 21, 0]);
  expectCalendar("1978/3/12 23:28:59.29", [1978, 3, 12, 23, 28, 59.29]);
  expectCalendar('17JUN1982 18:28:28', [1982, 6, 17, 18, 28, 28]);
  expectCalendar('13:28:28.128 1992 27 Jun', [1992, 6, 27, 13, 28, 28.128]);
  expectCalendar('1972 27 jun 12:29', [1972, 6, 27, 12, 29, 0]);
  expectCalendar("'93 Jan 23 12:29:47.289", [1993, 1, 23, 12, 29, 47.289]);
  expectCalendar('27 Jan 3, 19:12:28.182', [2027, 1, 3, 19, 12, 28.182]);
  expectCalendar('23 A.D. APR 4, 18:28:29.29', [23, 4, 4, 18, 28, 29.29]);
  expectCalendar('18 B.C. Jun 3, 12:29:28.291', [-17, 6, 3, 12, 29, 28.291]);
  expectCalendar('29 Jun  30 12:29:29.298', [2029, 6, 30, 12, 29, 29.298]);
  expectCalendar("29 Jun '30 12:29:29.298", [2030, 6, 29, 12, 29, 29.298]);
});

test('day-of-year format examples from the str2et_c documentation', () => {
  expectDoy('1997-162::12:18:28.827', 1997, 162, [12, 18, 28.827]);
  expectDoy('162-1996/12:28:28.287', 1996, 162, [12, 28, 28.287]);
  expectDoy('1992 183// 12:18:19', 1992, 183, [12, 18, 19]);
  expectDoy("'92-271/ 12:28:30.291", 1992, 271, [12, 28, 30.291]);
  expectDoy('92-182/ 18:28:28.281', 1992, 182, [18, 28, 28.281]);
  expectDoy('182-92/ 12:29:29.192', 182, 92, [12, 29, 29.192]); // literal (un-pivoted) year, per the "+" rule
  expectDoy("182-'92/ 12:28:29.182", 1992, 182, [12, 28, 29.182]);
  // NOTE: the documentation's "1993-321/12:28:28.287" row lists DOY
  // 231 in its result column, which looks like a 321/231 transcription
  // typo in NAIF's own docs -- verified against the algorithm (DOY is
  // just the digits after the dash) rather than matched here.
  expectDoy('1993-321/12:28:28.287', 1993, 321, [12, 28, 28.287]);
});

test('Julian date examples from the str2et_c documentation', () => {
  assert.deepEqual(parseTimeString('jd 28272.291'), { contSec: (28272.291 - 2451545.0) * 86400, system: 'UTC' });
  assert.deepEqual(parseTimeString('2451515.2981 (JD)'), {
    contSec: (2451515.2981 - 2451545.0) * 86400,
    system: 'UTC',
  });
  assert.deepEqual(parseTimeString('2451515.2981 JD'), {
    contSec: (2451515.2981 - 2451545.0) * 86400,
    system: 'UTC',
  });
});

test('A.M./P.M. labels', () => {
  expectCalendar('1988 June 13, 3:29:48 P.M.', [1988, 6, 13, 15, 29, 48]);
  expectCalendar('1988 June 13, 12:29:48 A.M.', [1988, 6, 13, 0, 29, 48]);
  expectCalendar('1988 June 13, 12:29:48 P.M.', [1988, 6, 13, 12, 29, 48]);
  assert.throws(() => parseTimeString('1988 June 13, 13:29:48 P.M.'), /between 1 and 12/);
});

test('U.S. named time zones are converted to UTC', () => {
  // PST is UTC-8, so 15:29:48 PST is 23:29:48 UTC the same day.
  expectCalendar('1988 June 13, 3:29:48 P.M. PST', [1988, 6, 13, 23, 29, 48]);
});

test('leap seconds occur at the same instant in every time zone', () => {
  const utc = parseTimeString('1995 December 31  23:59:60.5 UTC');
  const calcutta = parseTimeString('1996 January   1, 05:29:60.5 UTC+5:30');
  assert.ok(Math.abs(utc.contSec - calcutta.contSec) < 1e-6);
});
