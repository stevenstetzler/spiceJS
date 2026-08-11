import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelPool } from '../src/pool.js';
import { furnsh } from '../src/kernels.js';
import { str2et } from '../src/str2et.js';
import { et2utc } from '../src/et2utc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LSK = path.join(here, '../kernels/naif0012.tls');

function poolWithLsk() {
  const pool = new KernelPool();
  furnsh(LSK, pool);
  return pool;
}

test('str2et requires a leapseconds kernel for UTC strings', () => {
  const pool = new KernelPool();
  assert.throws(() => str2et('2000-01-01T12:00:00', pool), /leapseconds kernel/);
});

test('TDB-labeled strings need no kernel at all', () => {
  const pool = new KernelPool();
  assert.equal(str2et('2000-01-01T12:00:00 TDB', pool), 0);
});

test('str2et("2000-01-01T12:00:00") matches the well-known J2000 ET-UTC offset (~64.184s)', () => {
  const pool = poolWithLsk();
  const et = str2et('2000-01-01T12:00:00', pool);
  assert.ok(Math.abs(et - 64.1839272) < 1e-4, `got ${et}`);
});

test('equivalent time strings agree with each other', () => {
  const pool = poolWithLsk();
  const a = str2et('2000-01-01T12:00:00', pool);
  const b = str2et('2000 JAN 1 12:00:00', pool);
  const c = str2et('JD 2451545.0', pool);
  const d = str2et('1 JAN 2000 12:00:00', pool);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, d);
});

test('a leap second adds one extra real second across the 1999 boundary', () => {
  const pool = poolWithLsk();
  const before = str2et('1998-12-31T23:59:59', pool);
  const after = str2et('1999-01-01T00:00:00', pool);
  assert.ok(Math.abs(after - before - 2) < 1e-6, `expected ~2s gap, got ${after - before}`);
});

test('str2et / et2utc round-trip', () => {
  const pool = poolWithLsk();
  const samples = [
    '2000-01-01T12:00:00',
    '1972-01-01T00:00:00',
    '2017-01-01T00:00:00',
    '2026-08-11T06:30:45.250',
  ];
  for (const sample of samples) {
    const et = str2et(sample, pool);
    const back = et2utc(et, 3, pool);
    assert.equal(back, sample.length === 19 ? `${sample}.000` : sample, `round-trip for ${sample}`);
  }
});

test('str2et rejects UTC dates before the leapseconds table starts', () => {
  const pool = poolWithLsk();
  assert.throws(() => str2et('1960-01-01T00:00:00', pool), RangeError);
});

test('TDT-labeled strings need a leapseconds kernel (for K/EB/M) but no leap-second table lookup', () => {
  const pool = new KernelPool();
  assert.throws(() => str2et('2000-01-01T12:00:00 TDT', pool), /leapseconds kernel/);
});

test('TDT differs from TDB only by the sub-millisecond periodic term', () => {
  const pool = poolWithLsk();
  const tdb = str2et('2000-01-01T12:00:00 TDB', pool);
  const tdt = str2et('2000-01-01T12:00:00 TDT', pool);
  assert.equal(tdb, 0);
  assert.notEqual(tdt, 0);
  assert.ok(Math.abs(tdt) < 0.002, `expected a sub-millisecond correction, got ${tdt}`);
});

test('TDT is unaffected by leap seconds -- no jump across the 1999 boundary', () => {
  const pool = poolWithLsk();
  const before = str2et('1998-12-31T23:59:59 TDT', pool);
  const after = str2et('1999-01-01T00:00:00 TDT', pool);
  assert.ok(Math.abs(after - before - 1) < 1e-6, `expected exactly 1s gap, got ${after - before}`);
});
