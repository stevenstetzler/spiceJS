import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyValues } from '../src/bodyConstants.js';
import { KernelPool } from '../src/pool.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

test('bodyValues reads BODY<id>_<item> by NAIF ID', () => {
  const pool = new KernelPool();
  pool.putValues('BODY399_RADII', [6378.1366, 6378.1366, 6356.7519]);
  const radii = bodyValues(399, 'RADII', pool);
  assert.equal(radii.length, 3);
  closeTo(radii[0], 6378.1366);
  closeTo(radii[2], 6356.7519);
});

test('bodyValues resolves a body name string via bodyCode', () => {
  const pool = new KernelPool();
  pool.putValues('BODY399_GM', [398600.435507]);
  closeTo(bodyValues('EARTH', 'GM', pool)[0], 398600.435507);
  closeTo(bodyValues('earth', 'GM', pool)[0], 398600.435507); // case-insensitive
  closeTo(bodyValues('399', 'GM', pool)[0], 398600.435507); // plain-integer string
});

test('bodyValues throws a clear error when the constant is not loaded', () => {
  const pool = new KernelPool();
  assert.throws(() => bodyValues(399, 'RADII', pool), /no BODY399_RADII in the kernel pool/);
});

test('bodyValues propagates an unrecognized body name error from bodyCode', () => {
  const pool = new KernelPool();
  assert.throws(() => bodyValues('NOT_A_REAL_BODY', 'RADII', pool), /unrecognized body name/);
});
