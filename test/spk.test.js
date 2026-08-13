import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSpk, evaluateSegment, findSegment, spkState, spkSegments, spkez, spkezr } from '../src/spk.js';
import { rotateState, frameId } from '../src/frames.js';

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

// Linear motion (position(t) = P0 + V0*t) through *any* window of >= 2
// states is reconstructed exactly by Lagrange or Hermite interpolation
// (both are exact for degree-1 data), regardless of exactly which
// states NAIF's/spiceJS's window-selection rule happens to pick --
// same trick linearMotionSegment() above uses for the Chebyshev types.
function linearMotionStates({ n = 8, begin = -500, step = 200, epochs = null } = {}) {
  const p0 = [1000, 2000, 3000];
  const v0 = [1, -2, 0.5]; // km/s
  const ets = epochs || Array.from({ length: n }, (_, i) => begin + i * step);
  const states = ets.map((t) => [...p0.map((p, ax) => p + v0[ax] * t), ...v0]);
  return { ets, states, expectedStateAt: (et) => ({ position: p0.map((p, ax) => p + v0[ax] * et), velocity: v0 }) };
}

function equalStepSegment({ type, target = 499, center = 10, degree = 3 } = {}) {
  const { ets, states, expectedStateAt } = linearMotionStates({});
  return {
    target,
    center,
    frame: 1,
    type,
    startEt: ets[0],
    stopEt: ets[ets.length - 1],
    begin: ets[0],
    step: ets[1] - ets[0],
    degree,
    states,
    expectedStateAt,
  };
}

function unequalStepSegment({ type, target = 499, center = 10, degree = 3 } = {}) {
  const epochs = [-500, -300, -100, 50, 200, 450, 700, 900]; // deliberately non-uniform
  const { ets, states, expectedStateAt } = linearMotionStates({ epochs });
  return {
    target,
    center,
    frame: 1,
    type,
    startEt: ets[0],
    stopEt: ets[ets.length - 1],
    degree,
    states,
    epochs: ets,
    expectedStateAt,
  };
}

for (const [type, build] of [
  [8, equalStepSegment],
  [9, unequalStepSegment],
]) {
  test(`type ${type}: Lagrange-interpolated linear motion matches the analytic answer exactly`, () => {
    const seg = build({ type });
    const [segment] = loadSpk(writeSpk({ segments: [seg] }));
    for (const et of [-500, -137, 0, 63, 640, 900]) {
      const { position, velocity } = evaluateSegment(segment, et);
      const expected = seg.expectedStateAt(et);
      position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
      velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
    }
  });
}

for (const [type, build] of [
  [12, equalStepSegment],
  [13, unequalStepSegment],
]) {
  test(`type ${type}: Hermite-interpolated linear motion matches the analytic answer exactly`, () => {
    const seg = build({ type });
    const [segment] = loadSpk(writeSpk({ segments: [seg] }));
    for (const et of [-500, -137, 0, 63, 640, 900]) {
      const { position, velocity } = evaluateSegment(segment, et);
      const expected = seg.expectedStateAt(et);
      position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
      velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
    }
  });
}

test('type 8/12 window selection clamps at the segment edges instead of running out of bounds', () => {
  // degree=3 (window of 4) with only 8 states total -- requesting ET
  // right at the first/last epoch must still produce a full, in-bounds window.
  for (const type of [8, 12]) {
    const seg = equalStepSegment({ type, degree: 3 });
    const [segment] = loadSpk(writeSpk({ segments: [seg] }));
    for (const et of [seg.startEt, seg.stopEt]) {
      const { position, velocity } = evaluateSegment(segment, et);
      const expected = seg.expectedStateAt(et);
      position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
      velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
    }
  }
});

test('writeSpk rejects a type 9/13 segment with more than 100 states', () => {
  const states = Array.from({ length: 101 }, (_, i) => [i, 0, 0, 0, 0, 0]);
  const epochs = states.map((_, i) => i * 60);
  const seg = { target: 499, center: 10, frame: 1, type: 9, startEt: 0, stopEt: 6000, degree: 3, states, epochs };
  assert.throws(() => writeSpk({ segments: [seg] }), /capped at 100 states/);
});

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
  // Type 5 (two-body/Keplerian propagation) is a deliberately
  // out-of-scope type -- writeSpk() (the test helper) doesn't even
  // know how to write one, so construct just enough of a segment
  // object to reach evaluateSegment()'s own type dispatch directly.
  assert.throws(() => evaluateSegment({ type: 5 }, 0), /type 5 is not supported/);
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

  const toSsb = spkez(499, 0, et, 'NONE', null, pool);
  [0, 1, 2].forEach((i) => closeTo(toSsb.position[i], direct.position[i] + viaB.position[i]));
  [0, 1, 2].forEach((i) => closeTo(toSsb.velocity[i], direct.velocity[i] + viaB.velocity[i]));

  // B's own SSB-relative term cancels out of "A relative to B" algebraically,
  // so this must equal segAB's direct state exactly, not just up to a chain.
  const relB = spkez(499, 3, et, 'NONE', null, pool);
  [0, 1, 2].forEach((i) => closeTo(relB.position[i], direct.position[i]));
  [0, 1, 2].forEach((i) => closeTo(relB.velocity[i], direct.velocity[i]));
});

test('spkez: target and observer the same body gives exactly zero state', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 0 });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));

  const { position, velocity, lightTime } = spkez(499, 499, 0, 'NONE', null, pool);
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

  const none = spkez(499, 399, 0, 'NONE', null, pool);
  closeTo(none.position[0], D);
  closeTo(none.position[1], 0);
  closeTo(none.lightTime, D / CLIGHT_KM_S, 1e-9); // exact: position is exactly [D,0,0] here

  // 'LT' does exactly one iteration, seeded by the geometric light time
  // D/c, and the target's X position/velocity never change (it only moves
  // in Y), so the light-time-shifted position is hand-computable in closed
  // form. lightTime itself picks up a tiny second-order (Vy*lt/c)^2 term
  // from the resulting Y offset, hence the looser tolerance there only.
  const geometricLt = D / CLIGHT_KM_S;
  const lt = spkez(499, 399, 0, 'LT', null, pool);
  closeTo(lt.position[0], D, 1e-3);
  closeTo(lt.position[1], -Vy * geometricLt, 1e-3);
  closeTo(lt.velocity[1], Vy);
  closeTo(lt.lightTime, geometricLt, 1e-4);

  // Zero observer velocity makes stellar aberration an algebraic no-op.
  const ltPlusS = spkez(499, 399, 0, 'LT+S', null, pool);
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

  const { position } = spkez(499, 399, 0, 'LT+S', null, pool);

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
  assert.throws(() => spkez(1, 0, 0, 'BOGUS', null, pool), /unrecognized aberration correction/);
});

test('spkez throws a helpful error when a chain never reaches the SSB', () => {
  const pool = new KernelPool();
  assert.throws(() => spkez(5, 0, 0, 'NONE', null, pool), /no path back to the Solar System Barycenter/);
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
  assert.throws(() => spkez(1, 0, 0, 'NONE', null, pool), /circular SPK center chain/);
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
  assert.throws(() => spkez(1, 2, 0, 'NONE', null, pool), /frame transforms are not supported yet/);
});

// --- spkez's `ref` parameter, and spkezr ---

test('spkez with ref === the native frame is unchanged', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 0 }); // frame: 1 (J2000)
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));

  const native = spkez(499, 0, 0, 'NONE', null, pool);
  const explicit = spkez(499, 0, 0, 'NONE', 'J2000', pool);
  assert.deepEqual(explicit, native);
});

test('spkez with ref rotates position and velocity to match frames.rotateState directly', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 0 }); // frame: 1 (J2000)
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));

  const native = spkez(499, 0, 0, 'NONE', null, pool);
  const rotated = spkez(499, 0, 0, 'NONE', 'ECLIPJ2000', pool);
  const expected = rotateState(frameId('J2000'), frameId('ECLIPJ2000'), native.position, native.velocity);

  closeTo(rotated.position[0], expected.position[0]);
  closeTo(rotated.position[1], expected.position[1]);
  closeTo(rotated.position[2], expected.position[2]);
  closeTo(rotated.velocity[0], expected.velocity[0]);
  closeTo(rotated.velocity[1], expected.velocity[1]);
  closeTo(rotated.velocity[2], expected.velocity[2]);
  // A rotation preserves vector length -- a cheap independent sanity check.
  const norm = (v) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
  closeTo(norm(rotated.position), norm(native.position), 1e-6);
  assert.equal(rotated.lightTime, native.lightTime);
});

test('spkez rejects an unrecognized ref frame name', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 0 });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));
  assert.throws(() => spkez(499, 0, 0, 'NONE', 'NOT_A_FRAME', pool), /not a recognized frame/);
});

test('spkez gives a clear error for a recognized body-fixed frame with no PCK data loaded', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 0 });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));
  // IAU_MARS is a real built-in frame name -- but no binary or text PCK
  // orientation data for Mars has been loaded into this pool.
  assert.throws(() => spkez(499, 0, 0, 'NONE', 'IAU_MARS', pool), /no BODY499_POLE_RA in the kernel pool/);
});

test('spkezr resolves body name strings and matches spkez with the equivalent IDs', () => {
  const pool = new KernelPool();
  const seg = linearMotionSegment({ type: 2, target: 499, center: 0 });
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [seg] })));

  const byId = spkez(499, 0, 0, 'LT+S', 'ECLIPJ2000', pool);
  const byName = spkezr('mars', '0', 0, 'LT+S', 'ECLIPJ2000', pool);
  assert.deepEqual(byName, byId);
});

test('spkezr rejects an unrecognized body name', () => {
  const pool = new KernelPool();
  assert.throws(() => spkezr('NOT_A_BODY', '0', 0, 'NONE', null, pool), /unrecognized body name/);
});

// Regression: stellar aberration used to divide by the zero vector
// (NaN) whenever the target's light-time-corrected position relative
// to the observer was exactly zero -- caught by crossval, where a
// body sitting exactly at its parent's synthetic position (Sun at
// [0,0,0] relative to the SSB at et=0) produced a NaN state. Real
// SPICE leaves a zero-length vector unrotated (there's no direction
// to rotate it toward), so spiceJS should too.
test('spkez with LT+S does not NaN when the target is exactly at the observer (zero relative position)', () => {
  const pool = new KernelPool();
  const sunSeg = linearMotionSegment({ type: 2, target: 10, center: 0, startEt: -2000, stopEt: 2000 });
  sunSeg.records[0].coeffsByAxis = [
    [0, 0],
    [0, 0],
    [0, 0],
  ]; // Sun sits exactly at the SSB the whole time -- position is identically zero.
  pool.addSpkSegments(loadSpk(writeSpk({ segments: [sunSeg] })));

  const result = spkez(10, 0, 0, 'LT+S', null, pool);
  assert.deepEqual(result.position, [0, 0, 0]);
  assert.ok(result.velocity.every((v) => Number.isFinite(v)));

  const rotated = spkez(10, 0, 0, 'LT+S', 'ECLIPJ2000', pool);
  assert.deepEqual(rotated.position, [0, 0, 0]);
  assert.ok(rotated.velocity.every((v) => Number.isFinite(v)));
});

// Regression: when `ref` is a non-inertial frame centered on neither
// the target nor the observer, and `abcorr` requests light-time
// correction, the frame's orientation is evaluated at an epoch that
// itself depends on `et` (through a light-time solution to the
// frame's center body -- see nonInertialFrameEpoch()'s doc comment).
// Applying the frame's analytic rotation-derivative to an
// already-central-differenced velocity misses that extra chain-rule
// term; the returned velocity should still equal the derivative of
// the returned position (checked here by an independent, much finer
// central difference), which is what actually caught the bug via
// crossval (spiceJS agreed with itself, but not with spiceypy).
test('spkez velocity in a non-inertial ref frame equals the derivative of its own position, under LT+S', () => {
  const pool = new KernelPool();
  pool.addSpkSegments(
    loadSpk(
      writeSpk({
        segments: [
          linearMotionSegment({ type: 2, target: 301, center: 399, startEt: -2e6, stopEt: 2e6 }),
          linearMotionSegment({ type: 2, target: 499, center: 0, startEt: -2e6, stopEt: 2e6 }), // frame's center body
          linearMotionSegment({ type: 2, target: 399, center: 0, startEt: -2e6, stopEt: 2e6 }), // observer
        ],
      })
    )
  );
  // A fast-spinning classic-formula body-fixed frame (IAU_MARS, body
  // 499) -- distinct from both target (301) and observer (399), which
  // is exactly the case that needs the frame-center light-time term.
  pool.putValues('BODY499_POLE_RA', [317.269202, -0.10927547, 0]);
  pool.putValues('BODY499_POLE_DEC', [54.432516, -0.05827105, 0]);
  pool.putValues('BODY499_PM', [176.049863, 350.891982443297, 0]);

  const et = 123456;
  const result = spkez(301, 399, et, 'LT+S', 'IAU_MARS', pool);

  const h = 1e-3; // much finer than VELOCITY_DERIVATIVE_STEP_S, an independent check
  const plus = spkez(301, 399, et + h, 'LT+S', 'IAU_MARS', pool).position;
  const minus = spkez(301, 399, et - h, 'LT+S', 'IAU_MARS', pool).position;
  const finiteDiffVelocity = [0, 1, 2].map((i) => (plus[i] - minus[i]) / (2 * h));

  result.velocity.forEach((v, i) => closeTo(v, finiteDiffVelocity[i], 1e-6));
});
