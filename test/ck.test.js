import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCk, evaluateSegment, findCkPointing, ckgp, ckgpav, ckSegments } from '../src/ck.js';
import { KernelPool } from '../src/pool.js';
import { writeCk } from './helpers/writeCk.js';

const INST = -100000;
const J2000 = 1;
const B1950 = 2; // another built-in inertial frame -- a fixed, time-independent rotation from J2000

function closeTo(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} to be close to ${expected}`);
}

function matrixCloseTo(actual, expected, tol = 1e-9) {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      closeTo(actual[i][j], expected[i][j], tol);
    }
  }
}

function assertIsRotation(m, tol = 1e-9) {
  // Orthogonal (m * m^T = I) and proper (det = +1) -- true of every
  // real C-matrix, regardless of the specific rotation it represents.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const dot = m[i][0] * m[j][0] + m[i][1] * m[j][1] + m[i][2] * m[j][2];
      closeTo(dot, i === j ? 1 : 0, tol);
    }
  }
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  closeTo(det, 1, tol);
}

function type1Segment(overrides = {}) {
  return {
    inst: INST,
    refFrame: J2000,
    type: 1,
    avFlag: 1,
    startSclk: 0,
    stopSclk: 1000,
    records: [
      { time: 0, quat: [1, 0, 0, 0], av: [0, 0, 0] },
      { time: 100, quat: [1, 0, 0, 0], av: [0, 0, 0] },
    ],
    ...overrides,
  };
}

test('loadCk rejects a file that is not DAF/CK', async () => {
  const { writeSpk } = await import('./helpers/writeSpk.js');
  const notCk = writeSpk({ segments: [] });
  assert.throws(() => loadCk(notCk), /not a binary CK file/);
});

test('loadCk parses a synthetic single-segment file', () => {
  const buffer = writeCk({ segments: [type1Segment()] });
  const segments = loadCk(buffer);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].inst, INST);
  assert.equal(segments[0].refFrame, J2000);
  assert.equal(segments[0].type, 1);
  assert.equal(segments[0].avFlag, 1);
});

test('type 1: identity quaternion evaluates to the identity C-matrix', () => {
  const [segment] = loadCk(writeCk({ segments: [type1Segment()] }));
  const { found, cmat, av, clkout } = evaluateSegment(segment, 3, 10, true);
  assert.ok(found);
  assert.equal(clkout, 0); // nearest of {0, 100} to 3
  matrixCloseTo(cmat, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  assert.deepEqual(av, [0, 0, 0]);
});

test('type 1: nearest-instance search breaks a midpoint tie toward the later time', () => {
  const [segment] = loadCk(writeCk({ segments: [type1Segment()] }));
  const { clkout } = evaluateSegment(segment, 50, 1000, false); // exact midpoint of 0 and 100
  assert.equal(clkout, 100);
});

test('type 1: not found outside tolerance', () => {
  const [segment] = loadCk(writeCk({ segments: [type1Segment()] }));
  const { found } = evaluateSegment(segment, 50, 10, false); // 50 units from both instances, tol=10
  assert.equal(found, false);
});

test('type 1: needav throws when the segment has no angular velocity data', () => {
  const [segment] = loadCk(writeCk({ segments: [type1Segment({ avFlag: 0, records: [{ time: 0, quat: [1, 0, 0, 0] }] })] }));
  assert.throws(() => evaluateSegment(segment, 0, 10, true), /does not contain angular velocity data/);
});

test('type 2: fixed angular rate produces the expected rotation at the interval midpoint', () => {
  // A single interval [0, 1000], identity base quaternion, angular
  // velocity pi/1000 rad/s about +Z, rate=1 (seconds/tick) -- at
  // clkout=500 the elapsed rotation is (500 * 1) * (pi/1000) = pi/2.
  const segment0 = {
    inst: INST,
    refFrame: J2000,
    type: 2,
    startSclk: 0,
    stopSclk: 1000,
    intervals: [{ start: 0, stop: 1000, quat: [1, 0, 0, 0], av: [0, 0, Math.PI / 1000], rate: 1 }],
  };
  const [segment] = loadCk(writeCk({ segments: [segment0] }));
  const { found, cmat, av, clkout } = evaluateSegment(segment, 500, 10, true);
  assert.ok(found);
  assert.equal(clkout, 500);
  // cmat = cbase * rot^T where cbase=I and rot = axisAngleToMatrix's
  // standard forward-rotation-by-pi/2-about-Z matrix -- cross-checked
  // directly against spiceypy's own ckgpav on this exact scenario (see
  // crossval/gen-ck-fixture.py) before trusting this expected value:
  // an earlier, incorrect derivation of axisar_'s own convention
  // passed a self-consistent (but wrong) version of this same test,
  // and only crossval against real CSPICE caught it.
  matrixCloseTo(cmat, [
    [0, 1, 0],
    [-1, 0, 0],
    [0, 0, 1],
  ]);
  assert.deepEqual(av, [0, 0, Math.PI / 1000]);
});

test('type 2: not found when the request is outside every interval and past tolerance', () => {
  const segment0 = {
    inst: INST,
    refFrame: J2000,
    type: 2,
    startSclk: 0,
    stopSclk: 1000,
    intervals: [{ start: 0, stop: 1000, quat: [1, 0, 0, 0], av: [0, 0, 1], rate: 1 }],
  };
  const [segment] = loadCk(writeCk({ segments: [segment0] }));
  assert.equal(evaluateSegment(segment, 2000, 5, true).found, false);
});

test('type 3: interpolation reduces to the exact endpoint at frac=0 and frac=1', () => {
  const seg = {
    inst: INST,
    refFrame: J2000,
    type: 3,
    avFlag: 1,
    startSclk: 0,
    stopSclk: 1000,
    records: [
      { time: 0, quat: [1, 0, 0, 0], av: [0, 0, 0.01] },
      { time: 1000, quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], av: [0, 0, 0.02] }, // 90 degrees about Z
    ],
    intervalStarts: [0],
  };
  const [segment] = loadCk(writeCk({ segments: [seg] }));

  const atStart = evaluateSegment(segment, 0, 10, true);
  matrixCloseTo(atStart.cmat, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  assert.deepEqual(atStart.av, [0, 0, 0.01]);

  const atEnd = evaluateSegment(segment, 1000, 10, true);
  matrixCloseTo(atEnd.cmat, [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ]);
  assert.deepEqual(atEnd.av, [0, 0, 0.02]);
});

test('type 3: the interpolated midpoint is a real rotation and its own angular velocity is the linear blend', () => {
  const seg = {
    inst: INST,
    refFrame: J2000,
    type: 3,
    avFlag: 1,
    startSclk: 0,
    stopSclk: 1000,
    records: [
      { time: 0, quat: [1, 0, 0, 0], av: [0, 0, 0.01] },
      { time: 1000, quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], av: [0, 0, 0.02] },
    ],
    intervalStarts: [0],
  };
  const [segment] = loadCk(writeCk({ segments: [seg] }));
  const { found, cmat, av, clkout } = evaluateSegment(segment, 250, 10, true);
  assert.ok(found);
  assert.equal(clkout, 250);
  assertIsRotation(cmat);
  closeTo(av[2], 0.01 + 0.25 * (0.02 - 0.01)); // linear av blend, frac = 0.25
  assert.equal(av[0], 0);
  assert.equal(av[1], 0);
});

test('type 3: a gap between two intervals falls back to the closer endpoint within tolerance', () => {
  const seg = {
    inst: INST,
    refFrame: J2000,
    type: 3,
    avFlag: 0,
    startSclk: 0,
    stopSclk: 1000,
    records: [
      { time: 0, quat: [1, 0, 0, 0] },
      { time: 400, quat: [1, 0, 0, 0] }, // end of interval 1
      { time: 600, quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }, // start of interval 2
      { time: 1000, quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
    ],
    intervalStarts: [0, 600], // a real gap: (400, 600) has no continuous pointing
  };
  const [segment] = loadCk(writeCk({ segments: [seg] }));

  // Inside the gap, closer to the left endpoint (400) than the right (600).
  const closerToLeft = evaluateSegment(segment, 450, 100, false);
  assert.ok(closerToLeft.found);
  assert.equal(closerToLeft.clkout, 400);
  matrixCloseTo(closerToLeft.cmat, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);

  // Inside the gap, but farther from both endpoints than tolerance allows.
  assert.equal(evaluateSegment(segment, 500, 50, false).found, false);
});

test('findCkPointing falls through to a lower-priority segment when the higher-priority one has a gap', () => {
  const pool = new KernelPool();
  // Lower priority (loaded first): dense discrete pointing.
  pool.addCkSegments(
    loadCk(
      writeCk({
        segments: [
          {
            inst: INST,
            refFrame: J2000,
            type: 1,
            avFlag: 0,
            startSclk: 0,
            stopSclk: 1000,
            records: [
              { time: 0, quat: [1, 0, 0, 0] },
              { time: 500, quat: [1, 0, 0, 0] },
              { time: 1000, quat: [1, 0, 0, 0] },
            ],
          },
        ],
      })
    )
  );
  // Higher priority (loaded last): sparse discrete pointing with a real
  // gap around the request time -- mirrors ckgp_c's own documented
  // "Case 2" (segment priority + tolerance fallthrough).
  pool.addCkSegments(
    loadCk(
      writeCk({
        segments: [
          {
            inst: INST,
            refFrame: J2000,
            type: 1,
            avFlag: 0,
            startSclk: 0,
            stopSclk: 1000,
            records: [
              { time: 0, quat: [1, 0, 0, 0] },
              { time: 1000, quat: [1, 0, 0, 0] },
            ],
          },
        ],
      })
    )
  );

  const result = findCkPointing(pool, INST, 500, 10, false);
  assert.ok(result.found);
  assert.equal(result.clkout, 500); // only the lower-priority (first-loaded) segment has a record here
});

test('ckgp composes a fixed rotation when the requested frame differs from the segment frame', () => {
  const pool = new KernelPool();
  pool.addCkSegments(loadCk(writeCk({ segments: [type1Segment()] })));
  const direct = ckgp(INST, 0, 10, 'J2000', pool);
  const composed = ckgp(INST, 0, 10, 'B1950', pool);
  assert.ok(direct.found && composed.found);
  assertIsRotation(composed.cmat);
  // Both frames are inertial (no `et` needed, no SCLK kernel loaded at
  // all) -- the composed result must still be a real rotation, and
  // must differ from the direct (uncomposed) one, since J2000 and
  // B1950 are a real, nonzero fixed rotation apart.
  assert.notEqual(composed.cmat[0][1], direct.cmat[0][1]);
});

test('ckgp returns found:false when no segment satisfies the request', () => {
  const pool = new KernelPool();
  pool.addCkSegments(loadCk(writeCk({ segments: [type1Segment()] })));
  assert.equal(ckgp(INST, 5000, 1, 'J2000', pool).found, false);
});

test('ckgpav returns av unchanged when the requested frame matches the segment frame', () => {
  const pool = new KernelPool();
  const seg = {
    inst: INST,
    refFrame: J2000,
    type: 1,
    avFlag: 1,
    startSclk: 0,
    stopSclk: 1000,
    records: [{ time: 0, quat: [1, 0, 0, 0], av: [0.1, 0.2, 0.3] }],
  };
  pool.addCkSegments(loadCk(writeCk({ segments: [seg] })));
  const result = ckgpav(INST, 0, 10, 'J2000', pool);
  assert.ok(result.found);
  assert.deepEqual(result.av, [0.1, 0.2, 0.3]);
});

test('ckgpav composes av through a fixed (non-rotating-relative) frame change with no extra omega term', () => {
  const pool = new KernelPool();
  const seg = {
    inst: INST,
    refFrame: J2000,
    type: 1,
    avFlag: 1,
    startSclk: 0,
    stopSclk: 1000,
    records: [{ time: 0, quat: [1, 0, 0, 0], av: [0.1, 0.2, 0.3] }],
  };
  pool.addCkSegments(loadCk(writeCk({ segments: [seg] })));
  const { found, av } = ckgpav(INST, 0, 10, 'B1950', pool);
  assert.ok(found);
  // Two inertial frames have no relative rotation, so the composed av
  // is a pure rotation of the original vector -- same magnitude.
  closeTo(Math.hypot(...av), Math.hypot(0.1, 0.2, 0.3));
});

test('evaluateSegment rejects an unsupported CK data type', () => {
  // The type check happens before any byte is read, so a segment
  // object doesn't need a real buffer to exercise it.
  const segment = { type: 6 };
  assert.throws(() => evaluateSegment(segment, 0, 10, false), /segment data type 6 is not supported yet/);
});

test('ckSegments lists loaded segment descriptors', () => {
  const pool = new KernelPool();
  pool.addCkSegments(loadCk(writeCk({ segments: [type1Segment()] })));
  const list = ckSegments(pool);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { inst: INST, refFrame: J2000, type: 1, avFlag: 1, startSclk: 0, stopSclk: 1000 });
});
