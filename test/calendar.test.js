import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarToSeconds,
  secondsToCalendar,
  monthNumber,
  parseAtLiteral,
} from '../src/time/calendar.js';

test('J2000 epoch maps to 0', () => {
  assert.equal(calendarToSeconds(2000, 1, 1, 12, 0, 0), 0);
});

test('one day is exactly 86400 seconds', () => {
  const a = calendarToSeconds(2000, 1, 1, 12, 0, 0);
  const b = calendarToSeconds(2000, 1, 2, 12, 0, 0);
  assert.equal(b - a, 86400);
});

test('calendarToSeconds / secondsToCalendar round-trip', () => {
  const cases = [
    [1972, 1, 1, 0, 0, 0],
    [1999, 12, 31, 23, 59, 59],
    [2017, 1, 1, 0, 0, 0],
    [2026, 8, 11, 6, 30, 45.25],
    [1900, 2, 28, 0, 0, 0],
  ];
  for (const [y, mo, d, h, mi, s] of cases) {
    const sec = calendarToSeconds(y, mo, d, h, mi, s);
    const back = secondsToCalendar(sec);
    assert.equal(back.year, y, `year for ${y}-${mo}-${d}`);
    assert.equal(back.month, mo, `month for ${y}-${mo}-${d}`);
    assert.equal(back.day, d, `day for ${y}-${mo}-${d}`);
    assert.equal(back.hour, h);
    assert.equal(back.minute, mi);
    assert.ok(Math.abs(back.second - s) < 1e-6);
  }
});

test('monthNumber accepts 3-letter abbreviations, case-insensitively', () => {
  assert.equal(monthNumber('JAN'), 1);
  assert.equal(monthNumber('dec'), 12);
  assert.equal(monthNumber('September'), 9);
  assert.throws(() => monthNumber('XYZ'));
});

test('parseAtLiteral parses bare @date and @date/time literals', () => {
  assert.equal(parseAtLiteral('@1972-JAN-1'), calendarToSeconds(1972, 1, 1));
  assert.equal(parseAtLiteral('@1986-JAN-18/12:30:00'), calendarToSeconds(1986, 1, 18, 12, 30, 0));
});
