import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPck, evaluateSegment, findPckSegment, pckSegments } from '../src/pck.js';
import { KernelPool } from '../src/pool.js';
import { writePck } from './helpers/writePck.js';
import { writeSpk } from './helpers/writeSpk.js';

function closeTo(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} to be close to ${expected}`);
}

function eulerSegment(overrides = {}) {
  return {
    frame: 31008,
    refFrame: 1, // J2000
    type: 2,
    startEt: -1800,
    stopEt: 1800,
    init: -1800,
    intlen: 3600,
    records: [
      {
        mid: 0,
        radius: 1800,
        // [phi, delta, w], each [c0, c1] -- linear in s = (et - mid) / radius.
        coeffsByAxis: [
          [0.1, 0.05],
          [0.2, -0.02],
          [1.0, 0.3],
        ],
      },
    ],
    ...overrides,
  };
}

test('loadPck rejects a file that is not DAF/PCK', () => {
  // A real (empty, but otherwise well-formed) SPK file -- exercises
  // loadPck's own type check, distinct from daf.js's format checks.
  const notPck = writeSpk({ segments: [] });
  assert.throws(() => loadPck(notPck), /not a binary PCK file/);
});

test('loadPck parses a synthetic single-segment file', () => {
  const buffer = writePck({ segments: [eulerSegment()] });
  const segments = loadPck(buffer);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].frame, 31008);
  assert.equal(segments[0].refFrame, 1);
  assert.equal(segments[0].type, 2);
  assert.equal(segments[0].startEt, -1800);
  assert.equal(segments[0].stopEt, 1800);
});

test('evaluateSegment evaluates type 2 Euler angles and rates at a known point', () => {
  const [segment] = loadPck(writePck({ segments: [eulerSegment()] }));
  // s = (900 - 0) / 1800 = 0.5; T0(s)=1, T1(s)=s -> value = c0 + c1*s.
  const { eulerAngles, eulerRates } = evaluateSegment(segment, 900);
  closeTo(eulerAngles[0], 0.1 + 0.05 * 0.5); // phi
  closeTo(eulerAngles[1], 0.2 - 0.02 * 0.5); // delta
  closeTo(eulerAngles[2], 1.0 + 0.3 * 0.5); // w
  closeTo(eulerRates[0], 0.05 / 1800);
  closeTo(eulerRates[1], -0.02 / 1800);
  closeTo(eulerRates[2], 0.3 / 1800);
});

test('evaluateSegment rejects unsupported segment types', () => {
  const [segment] = loadPck(writePck({ segments: [eulerSegment({ type: 20 })] }));
  assert.throws(() => evaluateSegment(segment, 0), /segment data type 20 is not supported yet/);
});

test('findPckSegment finds the segment covering a frame/time, or null otherwise', () => {
  const pool = new KernelPool();
  pool.addPckSegments(loadPck(writePck({ segments: [eulerSegment()] })));

  assert.ok(findPckSegment(pool, 31008, 0));
  assert.equal(findPckSegment(pool, 31008, 5000), null); // outside coverage
  assert.equal(findPckSegment(pool, 999, 0), null); // wrong frame
});

test('findPckSegment prefers the last-loaded covering segment', () => {
  const pool = new KernelPool();
  pool.addPckSegments(loadPck(writePck({ segments: [eulerSegment({ records: [{ mid: 0, radius: 1800, coeffsByAxis: [[1, 0], [1, 0], [1, 0]] }] })] })));
  pool.addPckSegments(loadPck(writePck({ segments: [eulerSegment({ records: [{ mid: 0, radius: 1800, coeffsByAxis: [[2, 0], [2, 0], [2, 0]] }] })] })));

  const found = findPckSegment(pool, 31008, 0);
  const { eulerAngles } = evaluateSegment(found, 0);
  closeTo(eulerAngles[0], 2);
});

test('pckSegments lists loaded segment descriptors', () => {
  const pool = new KernelPool();
  pool.addPckSegments(loadPck(writePck({ segments: [eulerSegment()] })));
  const list = pckSegments(pool);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { frame: 31008, refFrame: 1, type: 2, startEt: -1800, stopEt: 1800 });
});
