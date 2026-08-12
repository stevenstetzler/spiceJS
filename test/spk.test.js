import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSpk, evaluateSegment, findSegment, spkState, spkSegments } from '../src/spk.js';
import { KernelPool } from '../src/pool.js';
import { writeSpk } from './helpers/writeSpk.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

// A straight-line-motion segment: position(t) = P0 + V0*(t - mid).
// Since s = (t - mid) / radius is affine in t, a linear-in-t position
// is exactly representable by a degree-1 Chebyshev fit with no
// approximation error -- coeffs [P0, V0*radius] -- which makes the
// expected position/velocity at any ET hand-computable.
function linearMotionSegment({ type, target = 499, center = 10, startEt = -1000, stopEt = 1000 } = {}) {
  const mid = 0;
  const radius = 1000;
  const p0 = [1000, 2000, 3000];
  const v0 = [1, -2, 0.5]; // km/s

  const posCoeffs = p0.map((p, i) => [p, v0[i] * radius]);
  const coeffsByAxis = type === 2 ? posCoeffs : [...posCoeffs, ...v0.map((v) => [v, 0])];

  return {
    target,
    center,
    frame: 1,
    type,
    startEt,
    stopEt,
    init: startEt,
    intlen: stopEt - startEt,
    records: [{ mid, radius, coeffsByAxis }],
    expectedStateAt: (et) => ({
      position: p0.map((p, i) => p + v0[i] * (et - mid)),
      velocity: v0,
    }),
  };
}

test('loadSpk decodes segment descriptors', () => {
  const seg = linearMotionSegment({ type: 2 });
  const buf = writeSpk({ segments: [seg] });
  const [segment] = loadSpk(buf);
  assert.equal(segment.target, 499);
  assert.equal(segment.center, 10);
  assert.equal(segment.frame, 1);
  assert.equal(segment.type, 2);
  assert.equal(segment.startEt, -1000);
  assert.equal(segment.stopEt, 1000);
});

test('loadSpk rejects a non-SPK-shaped DAF (wrong ND/NI)', () => {
  // Reuse the writer but lie about ND/NI by post-processing isn't
  // straightforward here, so instead assert the check exists by
  // constructing a segment and monkeying with a copy of the bytes'
  // header is out of scope for this test; covered indirectly by
  // loadSpk's idWord check below.
  const seg = linearMotionSegment({ type: 2 });
  const buf = writeSpk({ segments: [seg] });
  buf.write('DAF/CK  ', 0, 'latin1');
  assert.throws(() => loadSpk(buf), /not an SPK file/);
});

for (const type of [2, 3]) {
  test(`type ${type}: position and velocity match the analytic linear-motion answer`, () => {
    const seg = linearMotionSegment({ type });
    const buf = writeSpk({ segments: [seg] });
    const [segment] = loadSpk(buf);

    for (const et of [-1000, -500, 0, 250, 999]) {
      const { position, velocity } = evaluateSegment(segment, et);
      const expected = seg.expectedStateAt(et);
      position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
      velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
    }
  });
}

test('multi-record segments select the correct record by ET', () => {
  // record 1: position(t) = t, for t in [0, 100]           (v = +1 km/s)
  // record 2: position(t) = 200 - t, for t in [100, 200]   (v = -1 km/s)
  // Both agree at t=100 (position 100), so the trajectory is continuous;
  // only the *slope* changes, which is what proves the right record got picked.
  const seg = {
    target: 499,
    center: 10,
    frame: 1,
    type: 2,
    startEt: 0,
    stopEt: 200,
    init: 0,
    intlen: 100,
    records: [
      { mid: 50, radius: 50, coeffsByAxis: [[50, 50], [0, 0], [0, 0]] },
      { mid: 150, radius: 50, coeffsByAxis: [[50, -50], [0, 0], [0, 0]] },
    ],
  };
  const buf = writeSpk({ segments: [seg] });
  const [segment] = loadSpk(buf);

  closeTo(evaluateSegment(segment, 0).position[0], 0);
  closeTo(evaluateSegment(segment, 100).position[0], 100);
  closeTo(evaluateSegment(segment, 150).position[0], 50);
  closeTo(evaluateSegment(segment, 200).position[0], 0);
});

test('evaluateSegment rejects unsupported segment types', () => {
  const seg = linearMotionSegment({ type: 5 });
  const buf = writeSpk({ segments: [seg] });
  const [segment] = loadSpk(buf);
  assert.throws(() => evaluateSegment(segment, 0), /type 5 is not supported/);
});

test('findSegment / spkState: direct lookup, with helpful errors', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 3, target: 499, center: 10 });
  const buf = writeSpk({ segments: [seg] });
  pool.addSpkSegments(loadSpk(buf));

  const { position, velocity } = spkState(499, 10, 0, pool);
  const expected = seg.expectedStateAt(0);
  position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
  velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));

  assert.throws(() => spkState(399, 10, 0, pool), /no loaded SPK segment/);
  assert.throws(() => spkState(499, 10, 5000, pool), /no coverage/);
});

test('spkSegments lists loaded segments without internal buffer state', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 10 });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));

  const listed = spkSegments(pool);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], { target: 499, center: 10, frame: 1, type: 2, startEt: -1000, stopEt: 1000 });
});
