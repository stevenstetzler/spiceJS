import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyCode } from '../src/bodies.js';
import { KernelPool } from '../src/pool.js';

test('resolves common body names', () => {
  assert.equal(bodyCode('EARTH'), 399);
  assert.equal(bodyCode('MARS BARYCENTER'), 4);
  assert.equal(bodyCode('SSB'), 0);
  assert.equal(bodyCode('SOLAR SYSTEM BARYCENTER'), 0);
});

test('is case-insensitive and collapses internal whitespace, but not underscores', () => {
  assert.equal(bodyCode('earth'), 399);
  assert.equal(bodyCode('Mars Barycenter'), 4);
  assert.equal(bodyCode('MARS   BARYCENTER'), 4); // extra internal spaces collapse
  assert.equal(bodyCode('  earth  '), 399); // leading/trailing trimmed
  assert.equal(bodyCode('MARS_BARYCENTER'), 4); // underscore variant is its own alias
});

test('multiple aliases resolve to the same ID', () => {
  assert.equal(bodyCode('EARTH_BARYCENTER'), 3);
  assert.equal(bodyCode('EMB'), 3);
  assert.equal(bodyCode('EARTH-MOON BARYCENTER'), 3);
  assert.equal(bodyCode('EARTH MOON BARYCENTER'), 3);
});

test('a plain integer string is used directly, bypassing the name table', () => {
  assert.equal(bodyCode('399'), 399);
  assert.equal(bodyCode('-64'), -64);
  assert.equal(bodyCode('0'), 0);
});

test('rejects unrecognized names', () => {
  assert.throws(() => bodyCode('NOT_A_REAL_BODY'), /unrecognized body name/);
});

test('a pool-defined NAIF_BODY_NAME/NAIF_BODY_CODE pair takes priority over the built-in table', () => {
  const pool = new KernelPool();
  pool.putValues('NAIF_BODY_NAME', ['MYSAT']);
  pool.putValues('NAIF_BODY_CODE', [-100]);
  assert.equal(bodyCode('MYSAT', pool), -100);
  assert.equal(bodyCode('mysat', pool), -100);
  // Built-in names still resolve when not overridden.
  assert.equal(bodyCode('EARTH', pool), 399);
});

test('a pool-defined name can override a built-in one', () => {
  const pool = new KernelPool();
  pool.putValues('NAIF_BODY_NAME', ['EARTH']);
  pool.putValues('NAIF_BODY_CODE', [-999]);
  assert.equal(bodyCode('EARTH', pool), -999);
});
