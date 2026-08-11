import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelPool } from '../src/pool.js';
import { furnsh, unload, kclear } from '../src/kernels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LSK = path.join(here, '../kernels/naif0012.tls');
const META_KERNEL = path.join(here, '../kernels/basic.tm');

test('furnsh loads a leapseconds text kernel into the pool', () => {
  const pool = new KernelPool();
  furnsh(LSK, pool);
  assert.equal(pool.getValues('DELTET/DELTA_T_A')[0], 32.184);
  assert.deepEqual(pool.getValues('DELTET/M'), [6.239996, 1.99096871e-7]);
  const deltaAt = pool.getValues('DELTET/DELTA_AT');
  assert.equal(deltaAt.length, 28 * 2);
  assert.equal(deltaAt[deltaAt.length - 2], 37); // most recent leap second count
});

test('unload undoes exactly what furnsh loaded', () => {
  const pool = new KernelPool();
  furnsh(LSK, pool);
  assert.equal(pool.has('DELTET/DELTA_T_A'), true);
  unload(LSK, pool);
  assert.equal(pool.has('DELTET/DELTA_T_A'), false);
});

test('unload is a no-op for a file that was never loaded', () => {
  const pool = new KernelPool();
  assert.doesNotThrow(() => unload(LSK, pool));
});

test('kclear empties the pool and forgets load history', () => {
  const pool = new KernelPool();
  furnsh(LSK, pool);
  kclear(pool);
  assert.deepEqual(pool.names(), []);
});

test('furnsh expands a meta-kernel and loads what it lists', () => {
  const pool = new KernelPool();
  furnsh(META_KERNEL, pool);
  assert.equal(pool.getValues('DELTET/DELTA_T_A')[0], 32.184);
});

test('furnsh rejects a file that does not look like a text kernel', () => {
  const pool = new KernelPool();
  assert.throws(() => furnsh(path.join(here, '../package.json'), pool), /does not look like a recognized SPICE kernel/);
});

test('furnsh rejects a binary-kernel-looking file with a helpful message', () => {
  const pool = new KernelPool();
  const fakeSpk = path.join(os.tmpdir(), `spicejs-test-fake-${process.pid}.bsp`);
  fs.writeFileSync(fakeSpk, 'DAF/SPK                                                                        ');
  try {
    assert.throws(() => furnsh(fakeSpk, pool), /not supported yet by spiceJS/);
  } finally {
    fs.unlinkSync(fakeSpk);
  }
});
