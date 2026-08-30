import test from 'node:test';
import assert from 'node:assert/strict';
import { KernelPool } from '../src/pool.js';

test('putValues / getValues round-trip', () => {
  const pool = new KernelPool();
  pool.putValues('FOO', [1, 2, 3]);
  assert.deepEqual(pool.getValues('FOO'), [1, 2, 3]);
});

test('putValues accepts a bare scalar', () => {
  const pool = new KernelPool();
  pool.putValues('FOO', 42);
  assert.deepEqual(pool.getValues('FOO'), [42]);
});

test('putValues without append overwrites', () => {
  const pool = new KernelPool();
  pool.putValues('FOO', [1, 2]);
  pool.putValues('FOO', [9]);
  assert.deepEqual(pool.getValues('FOO'), [9]);
});

test('putValues with append extends', () => {
  const pool = new KernelPool();
  pool.putValues('FOO', [1, 2]);
  pool.putValues('FOO', [3, 4], true);
  assert.deepEqual(pool.getValues('FOO'), [1, 2, 3, 4]);
});

test('getValues returns undefined for unset variables', () => {
  const pool = new KernelPool();
  assert.equal(pool.getValues('NOPE'), undefined);
});

test('getValues returns a copy, not a live reference', () => {
  const pool = new KernelPool();
  pool.putValues('FOO', [1, 2]);
  const values = pool.getValues('FOO');
  values.push(3);
  assert.deepEqual(pool.getValues('FOO'), [1, 2]);
});

test('has / deleteVar / names / clear', () => {
  const pool = new KernelPool();
  pool.putValues('A', [1]);
  pool.putValues('B', [2]);
  assert.equal(pool.has('A'), true);
  assert.deepEqual(pool.names().sort(), ['A', 'B']);
  pool.deleteVar('A');
  assert.equal(pool.has('A'), false);
  pool.clear();
  assert.deepEqual(pool.names(), []);
});
