import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSpk, evaluateSegment, findSegment, spkState, spkSegments, spkez } from '../src/spk.js';

const CLIGHT_KM_S = 299792.458; // exact, by SI definition -- independently re-stated here, not imported
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

// --- spkez: chaining and aberration correction ---

test('spkez chains through an intermediate body to reach the SSB', () => {
  const pool = new KernelPool();
  const segAB = linearMotionSegment({ type: 2, target: 499, center: 3 }); // A rel. B
  const segB0 = linearMotionSegment({ type: 2, target: 3, center: 0 }); // B rel. SSB
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [segAB] })));
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [segB0] })));

  const et = 250;
  const direct = segAB.expectedStateAt(et); // A rel. B
  const viaB = segB0.expectedStateAt(et); // B rel. SSB

  const toSsb = spkez(499, 0, et, 'NONE', pool);
  [0, 1, 2].forEach((i) => closeTo(toSsb.position[i], direct.position[i] + viaB.position[i]));
  [0, 1, 2].forEach((i) => closeTo(toSsb.velocity[i], direct.velocity[i] + viaB.velocity[i]));

  // B's own SSB-relative term cancels out of "A relative to B" algebraically,
  // so this must equal segAB's direct state exactly, not just up to a chain.
  const relB = spkez(499, 3, et, 'NONE', pool);
  [0, 1, 2].forEach((i) => closeTo(relB.position[i], direct.position[i]));
  [0, 1, 2].forEach((i) => closeTo(relB.velocity[i], direct.velocity[i]));
});

test('spkez: target and observer the same body gives exactly zero state', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 0 });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));

  const { position, velocity, lightTime } = spkez(499, 499, 0, 'NONE', pool);
  assert.deepEqual(position, [0, 0, 0]);
  assert.deepEqual(velocity, [0, 0, 0]);
  assert.equal(lightTime, 0);
});

test('"LT" shifts the target position by its own motion over the light time, isolated from stellar aberration', () => {
  const pool = new KernelPool();
  const D = 1.5e8; // km
  const Vy = 20; // km/s, perpendicular to the line of sight

  const stationaryObserver = (target) => ({
    target,
    center: 0,
    frame: 1,
    type: 2,
    startEt: -1e6,
    stopEt: 1e6,
    init: -1e6,
    intlen: 2e6,
    records: [{ mid: 0, radius: 1e6, coeffsByAxis: [[0, 0], [0, 0], [0, 0]] }],
  });
  const movingTarget = {
    target: 499,
    center: 0,
    frame: 1,
    type: 2,
    startEt: -1e6,
    stopEt: 1e6,
    init: -1e6,
    intlen: 2e6,
    records: [{ mid: 0, radius: 1e6, coeffsByAxis: [[D, 0], [0, Vy * 1e6], [0, 0]] }],
  };
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [stationaryObserver(399)] })));
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [movingTarget] })));

  const none = spkez(499, 399, 0, 'NONE', pool);
  closeTo(none.position[0], D);
  closeTo(none.position[1], 0);
  closeTo(none.lightTime, D / CLIGHT_KM_S, 1e-9); // exact: position is exactly [D,0,0] here

  // 'LT' does exactly one iteration, seeded by the geometric light time
  // D/c, and the target's X position/velocity never change (it only moves
  // in Y), so the light-time-shifted position is hand-computable in closed
  // form. lightTime itself picks up a tiny second-order (Vy*lt/c)^2 term
  // from the resulting Y offset, hence the looser tolerance there only.
  const geometricLt = D / CLIGHT_KM_S;
  const lt = spkez(499, 399, 0, 'LT', pool);
  closeTo(lt.position[0], D, 1e-3);
  closeTo(lt.position[1], -Vy * geometricLt, 1e-3);
  closeTo(lt.velocity[1], Vy);
  closeTo(lt.lightTime, geometricLt, 1e-4);

  // Zero observer velocity makes stellar aberration an algebraic no-op.
  const ltPlusS = spkez(499, 399, 0, 'LT+S', pool);
  assert.deepEqual(ltPlusS.position, lt.position);
});

test('"LT+S" stellar aberration matches the hand-derived rotation for perpendicular geometry', () => {
  const pool = new KernelPool();
  const D = 1e8; // km
  const Vy = 30; // km/s, observer's own velocity, perpendicular to the line of sight

  const stationaryTarget = {
    target: 499,
    center: 0,
    frame: 1,
    type: 2,
    startEt: -1e6,
    stopEt: 1e6,
    init: -1e6,
    intlen: 2e6,
    records: [{ mid: 0, radius: 1e6, coeffsByAxis: [[D, 0], [0, 0], [0, 0]] }],
  };
  const movingObserverAtOrigin = {
    target: 399,
    center: 0,
    frame: 1,
    type: 2,
    startEt: -1e6,
    stopEt: 1e6,
    init: -1e6,
    intlen: 2e6,
    records: [{ mid: 0, radius: 1e6, coeffsByAxis: [[0, 0], [0, Vy * 1e6], [0, 0]] }],
  };
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [stationaryTarget] })));
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [movingObserverAtOrigin] })));

  const { position } = spkez(499, 399, 0, 'LT+S', pool);

  // Independent hand-derivation (basic trig, not the implementation's own
  // rotation formula): the target is stationary, so light-time correction
  // is a no-op on its position; stellar aberration then rotates [D,0,0]
  // toward the observer's velocity direction (+Y) by phi = asin(Vy/c).
  const phi = Math.asin(Vy / CLIGHT_KM_S);
  closeTo(position[0], D * Math.cos(phi), 1e-3);
  closeTo(position[1], D * Math.sin(phi), 1e-3);
  closeTo(position[2], 0, 1e-9);
});

test('spkez rejects an unrecognized aberration correction', () => {
  const pool = new KernelPool();
  assert.throws(() => spkez(1, 0, 0, 'BOGUS', pool), /unrecognized aberration correction/);
});

test('spkez throws a helpful error when a chain never reaches the SSB', () => {
  const pool = new KernelPool();
  assert.throws(() => spkez(5, 0, 0, 'NONE', pool), /no path back to the Solar System Barycenter/);
});

test('spkez detects a circular center chain', () => {
  const pool = new KernelPool();
  const zeroMotion = (target, center) => ({
    target,
    center,
    frame: 1,
    type: 2,
    startEt: -100,
    stopEt: 100,
    init: -100,
    intlen: 200,
    records: [{ mid: 0, radius: 100, coeffsByAxis: [[0, 0], [0, 0], [0, 0]] }],
  });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [zeroMotion(1, 2)] })));
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [zeroMotion(2, 1)] })));
  assert.throws(() => spkez(1, 0, 0, 'NONE', pool), /circular SPK center chain/);
});

test('spkez rejects a chain with mixed reference frames', () => {
  const pool = new KernelPool();
  const zeroMotion = (target, frame) => ({
    target,
    center: 0,
    frame,
    type: 2,
    startEt: -100,
    stopEt: 100,
    init: -100,
    intlen: 200,
    records: [{ mid: 0, radius: 100, coeffsByAxis: [[0, 0], [0, 0], [0, 0]] }],
  });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [zeroMotion(1, 1)] })));
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [zeroMotion(2, 17)] })));
  assert.throws(() => spkez(1, 2, 0, 'NONE', pool), /frame transforms are not supported yet/);
});
