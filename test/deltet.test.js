import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelPool } from '../src/pool.js';
import { furnsh } from '../src/kernels.js';
import { str2et } from '../src/str2et.js';
import { taiToEt, etToTai } from '../src/time/deltet.js';
import { et2tai, et2taiCalendar } from '../src/et2tai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LSK = path.join(here, '../kernels/naif0012.tls');

function poolWithLsk() {
  const pool = new KernelPool();
  furnsh(LSK, pool);
  return pool;
}

test('taiToEt/etToTai round-trip', () => {
  const pool = poolWithLsk();
  const et = str2et('2020-06-15T00:00:00', pool); // default (no label) is UTC
  const tai = etToTai(et, pool);
  assert.ok(Math.abs(taiToEt(tai, pool) - et) < 1e-9);
});

test('taiToEt matches real CSPICE (spiceypy unitim(et, "ET", "TAI")) at a known epoch', () => {
  // spiceypy, real naif0012.tls: str2et('2020-01-01 00:00:00 UTC') ->
  // 631108869.1839073; unitim(et, 'ET', 'TAI') -> 631108837.0 exactly.
  const pool = poolWithLsk();
  const et = str2et('2020-01-01 00:00:00 UTC', pool);
  assert.ok(Math.abs(et - 631108869.1839073) < 1e-6, `got et=${et}`);
  const tai = etToTai(et, pool);
  assert.ok(Math.abs(tai - 631108837.0) < 1e-6, `got tai=${tai}`);
  assert.ok(Math.abs(taiToEt(631108837.0, pool) - et) < 1e-6);
});

test('TAI needs no leap-second table -- only the LSK\'s periodic-term (K/EB/M) variables', () => {
  const pool = new KernelPool();
  // No DELTET/DELTA_AT defined at all, only the periodic-term trio.
  pool.putValues('DELTET/K', [1.657e-3]);
  pool.putValues('DELTET/EB', [1.671e-2]);
  pool.putValues('DELTET/M', [6.239996, 1.99096871e-7]);
  assert.doesNotThrow(() => taiToEt(0, pool));
});

test('et2tai/et2taiCalendar report a UTC-vs-TAI offset consistent with the loaded leap seconds', () => {
  const pool = poolWithLsk();
  const et = str2et('2020-01-01T00:00:00', pool); // UTC
  const taiIso = et2tai(et, 3, pool);
  const taiCal = et2taiCalendar(et, 3, pool);
  // As of 2020, TAI-UTC = 37s, so the same instant reads 37s later on
  // a TAI clock than on a UTC one (both midnight boundaries, so this
  // lands at 00:00:37 TAI on the same calendar day).
  assert.equal(taiIso, '2020-01-01T00:00:37.000');
  assert.equal(taiCal, '2020 JAN 01 00:00:37.000');
});
