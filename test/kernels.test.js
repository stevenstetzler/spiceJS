import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelPool } from '../src/pool.js';
import { furnsh, unload, kclear } from '../src/kernels.js';
import { spkState, spkSegments } from '../src/spk.js';
import { writeSpk } from './helpers/writeSpk.js';
import { writePck } from './helpers/writePck.js';
import { pckSegments } from '../src/pck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LSK = path.join(here, '../kernels/naif0012.tls');
const META_KERNEL = path.join(here, '../kernels/basic.tm');

function writeTempSpk(segments) {
  const filePath = path.join(os.tmpdir(), `spicejs-test-${process.pid}-${Math.random().toString(36).slice(2)}.bsp`);
  fs.writeFileSync(filePath, writeSpk({ segments }));
  return filePath;
}

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

test('furnsh rejects a binary kernel type it does not support yet, with a helpful message', () => {
  const pool = new KernelPool();
  const fakeCk = path.join(os.tmpdir(), `spicejs-test-fake-${process.pid}.bc`);
  fs.writeFileSync(fakeCk, 'DAF/CK                                                                          ');
  try {
    assert.throws(() => furnsh(fakeCk, pool), /Only binary SPK and PCK kernels are supported/);
  } finally {
    fs.unlinkSync(fakeCk);
  }
});

test('furnsh loads a binary SPK kernel and indexes its segments', () => {
  const pool = new KernelPool();
  const filePath = writeTempSpk([
    {
      target: 499,
      center: 10,
      frame: 1,
      type: 2,
      startEt: -1000,
      stopEt: 1000,
      init: -1000,
      intlen: 2000,
      records: [{ mid: 0, radius: 1000, coeffsByAxis: [[100, 10], [200, 20], [300, 30]] }],
    },
  ]);
  try {
    furnsh(filePath, pool);
    assert.deepEqual(spkSegments(pool), [
      { target: 499, center: 10, frame: 1, type: 2, startEt: -1000, stopEt: 1000 },
    ]);
    const { position, velocity } = spkState(499, 10, 0, pool);
    assert.deepEqual(position, [100, 200, 300]);
    assert.deepEqual(velocity, [0.01, 0.02, 0.03]);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('furnsh routes a generic "NAIF/DAF"-worded SPK-shaped file to SPK (real, older kernels use this word)', () => {
  const pool = new KernelPool();
  const buffer = writeSpk({
    segments: [
      {
        target: 399017,
        center: 399,
        frame: 13000,
        type: 2,
        startEt: -1000,
        stopEt: 1000,
        init: -1000,
        intlen: 2000,
        records: [{ mid: 0, radius: 1000, coeffsByAxis: [[573.5, 0], [-4986.7, 0], [3922.4, 0]] }],
      },
    ],
  });
  buffer.write('NAIF/DAF', 0, 'latin1');
  const filePath = path.join(os.tmpdir(), `spicejs-test-naifdaf-${process.pid}.bsp`);
  fs.writeFileSync(filePath, buffer);
  try {
    furnsh(filePath, pool);
    assert.deepEqual(spkSegments(pool), [
      { target: 399017, center: 399, frame: 13000, type: 2, startEt: -1000, stopEt: 1000 },
    ]);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('furnsh routes a generic "NAIF/DAF"-worded PCK-shaped file to PCK', () => {
  const pool = new KernelPool();
  const buffer = writePck({
    segments: [
      {
        frame: 31008,
        refFrame: 1,
        type: 2,
        startEt: -1000,
        stopEt: 1000,
        init: -1000,
        intlen: 2000,
        records: [{ mid: 0, radius: 1000, coeffsByAxis: [[0.1, 0], [0.2, 0], [0.3, 0]] }],
      },
    ],
  });
  buffer.write('NAIF/DAF', 0, 'latin1');
  const filePath = path.join(os.tmpdir(), `spicejs-test-naifdaf-${process.pid}.bpc`);
  fs.writeFileSync(filePath, buffer);
  try {
    furnsh(filePath, pool);
    assert.deepEqual(pckSegments(pool), [{ frame: 31008, refFrame: 1, type: 2, startEt: -1000, stopEt: 1000 }]);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('unload removes exactly the SPK segments a file contributed', () => {
  const pool = new KernelPool();
  const filePath = writeTempSpk([
    {
      target: 499,
      center: 10,
      frame: 1,
      type: 2,
      startEt: -1000,
      stopEt: 1000,
      init: -1000,
      intlen: 2000,
      records: [{ mid: 0, radius: 1000, coeffsByAxis: [[100, 10], [200, 20], [300, 30]] }],
    },
  ]);
  try {
    furnsh(filePath, pool);
    assert.equal(spkSegments(pool).length, 1);
    unload(filePath, pool);
    assert.equal(spkSegments(pool).length, 0);
    assert.throws(() => spkState(499, 10, 0, pool), /no loaded SPK segment/);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('kclear also clears loaded SPK segments', () => {
  const pool = new KernelPool();
  const filePath = writeTempSpk([
    {
      target: 499,
      center: 10,
      frame: 1,
      type: 2,
      startEt: -1000,
      stopEt: 1000,
      init: -1000,
      intlen: 2000,
      records: [{ mid: 0, radius: 1000, coeffsByAxis: [[100, 10], [200, 20], [300, 30]] }],
    },
  ]);
  try {
    furnsh(filePath, pool);
    kclear(pool);
    assert.equal(spkSegments(pool).length, 0);
  } finally {
    fs.unlinkSync(filePath);
  }
});
