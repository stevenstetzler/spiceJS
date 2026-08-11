import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeString } from '../src/time/parseTimeString.js';
import { calendarToSeconds } from '../src/time/calendar.js';

const J2000_NOON = calendarToSeconds(2000, 1, 1, 12, 0, 0);

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

test('free-form calendar strings in any field order', () => {
  const expected = { contSec: J2000_NOON, system: 'UTC' };
  assert.deepEqual(parseTimeString('2000 JAN 1 12:00:00'), expected);
  assert.deepEqual(parseTimeString('1 JAN 2000 12:00:00'), expected);
  assert.deepEqual(parseTimeString('JAN 1, 2000 12:00:00'), expected);
});

test('Julian date strings', () => {
  assert.deepEqual(parseTimeString('JD 2451545.0'), { contSec: 0, system: 'UTC' });
  assert.deepEqual(parseTimeString('JD 2451545.0 TDB'), { contSec: 0, system: 'TDB' });
});

test('two-digit years use the 1969-2068 pivot', () => {
  assert.equal(parseTimeString('1 JAN 68 00:00:00').contSec, calendarToSeconds(2068, 1, 1));
  assert.equal(parseTimeString('1 JAN 69 00:00:00').contSec, calendarToSeconds(1969, 1, 1));
});

test('rejects ambiguous dates where neither numeric field is clearly the year', () => {
  assert.throws(() => parseTimeString('01 JAN 02'), /ambiguous/);
});

test('rejects free-form dates with no month name at all', () => {
  assert.throws(() => parseTimeString('01 02 03'), /include a month name/);
});

test('rejects unparseable strings', () => {
  assert.throws(() => parseTimeString('not a time'));
  assert.throws(() => parseTimeString(''));
});

test('rejects the unsupported TDT system', () => {
  assert.throws(() => parseTimeString('2000-01-01T12:00:00 TDT'), /TDT/);
});
