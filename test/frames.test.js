import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frameId, frameCenter, rotateState } from '../src/frames.js';
import { globalPool, KernelPool } from '../src/pool.js';
import { furnsh, kclear } from '../src/kernels.js';
import { loadPck } from '../src/pck.js';
import { writePck } from './helpers/writePck.js';
import { tipmFromEulerAngles, transpose3 } from '../src/math/eulerFrame.js';

function closeVec(a, b, tol = 1e-9) {
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < tol, `component ${i}: expected ${a} to be close to ${b}`);
  }
}

function multiplyVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

test('frameId resolves known built-in inertial frames, case-insensitively', () => {
  assert.equal(frameId('J2000'), 1);
  assert.equal(frameId('j2000'), 1);
  assert.equal(frameId('B1950'), 2);
  assert.equal(frameId('ECLIPJ2000'), 17);
  assert.equal(frameId('GALACTIC'), 13);
});

test('frameId resolves known built-in body-fixed frames, case-insensitively', () => {
  assert.equal(frameId('IAU_MOON'), 10020);
  assert.equal(frameId('iau_earth'), 10013);
  assert.equal(frameId('IAU_MARS'), 10014);
});

test('frameId rejects unknown frame names', () => {
  assert.throws(() => frameId('NOT_A_FRAME'), /not a recognized frame/);
});

test('rotateState is the identity when fromId === toId', () => {
  const position = [1, 2, 3];
  const velocity = [4, 5, 6];
  const result = rotateState(1, 1, position, velocity);
  assert.deepEqual(result.position, position);
  assert.deepEqual(result.velocity, velocity);
});

test('rotateState preserves vector length (it is a pure rotation)', () => {
  const position = [1e8, 2e8, 3e7];
  const { position: rotated } = rotateState(frameId('J2000'), frameId('ECLIPJ2000'), position, [0, 0, 0]);
  const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm(rotated) - norm(position)) < 1e-6);
});

test('rotateState round-trips exactly (inverse rotation undoes it)', () => {
  const position = [1.5e8, -3e7, 2e6];
  const velocity = [10, -5, 2];
  const toEcliptic = rotateState(frameId('J2000'), frameId('ECLIPJ2000'), position, velocity);
  const back = rotateState(frameId('ECLIPJ2000'), frameId('J2000'), toEcliptic.position, toEcliptic.velocity);
  closeVec(back.position, position, 1e-6);
  closeVec(back.velocity, velocity, 1e-9);
});

test('rotating J2000 -> ECLIPJ2000 matches the well-known mean obliquity of J2000', () => {
  // The ecliptic frame is the equatorial frame rotated about +X by the
  // mean obliquity, 23.4392911 degrees -- an independently-known
  // constant, not re-derived from this module's own data.
  const obliquityRad = (23.4392911 * Math.PI) / 180;
  const { position } = rotateState(frameId('J2000'), frameId('ECLIPJ2000'), [0, 1, 0], [0, 0, 0]);
  closeVec(position, [0, Math.cos(obliquityRad), -Math.sin(obliquityRad)], 1e-6);
});

// --- class 2: FK-defined, binary-PCK-driven frames (like MOON_PA_DE440) ---

function fkPoolWithBinaryPckFrame(pool) {
  pool.putValues('FRAME_MOON_PA_DE440', 31008);
  pool.putValues('FRAME_31008_NAME', 'MOON_PA_DE440');
  pool.putValues('FRAME_31008_CLASS', 2);
  pool.putValues('FRAME_31008_CLASS_ID', 31008);
  pool.putValues('FRAME_31008_CENTER', 301);
  pool.addPckSegments(
    loadPck(
      writePck({
        segments: [
          {
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
                coeffsByAxis: [
                  [0.4, 0.02],
                  [0.3, -0.01],
                  [1.2, 0.5],
                ],
              },
            ],
          },
        ],
      })
    )
  );
  return pool;
}

test('rotateState resolves an FK-defined, binary-PCK-driven (class 2) frame to J2000', () => {
  const pool = fkPoolWithBinaryPckFrame(new KernelPool());
  const id = frameId('MOON_PA_DE440', pool);
  assert.equal(id, 31008);

  const et = 900; // s = (900 - 0) / 1800 = 0.5
  const phi = 0.4 + 0.02 * 0.5;
  const delta = 0.3 - 0.01 * 0.5;
  const w = 1.2 + 0.5 * 0.5;
  const dphi = 0.02 / 1800;
  const ddelta = -0.01 / 1800;
  const dw = 0.5 / 1800;
  const { tipm } = tipmFromEulerAngles(phi, delta, w, dphi, ddelta, dw);
  const bodyToJ2000 = transpose3(tipm);

  const bodyFixedPoint = [1000, 2000, 3000];
  const { position } = rotateState(id, frameId('J2000'), bodyFixedPoint, [0, 0, 0], et, pool);
  closeVec(position, multiplyVec(bodyToJ2000, bodyFixedPoint), 1e-9);
});

test('rotateState velocity for a class 2 frame matches a finite difference in time', () => {
  const pool = fkPoolWithBinaryPckFrame(new KernelPool());
  const id = frameId('MOON_PA_DE440', pool);
  const bodyFixedPoint = [1000, 2000, 3000];
  const et = 300;
  const h = 1e-3;

  const { velocity } = rotateState(id, frameId('J2000'), bodyFixedPoint, [0, 0, 0], et, pool);
  const plus = rotateState(id, frameId('J2000'), bodyFixedPoint, [0, 0, 0], et + h, pool).position;
  const minus = rotateState(id, frameId('J2000'), bodyFixedPoint, [0, 0, 0], et - h, pool).position;
  const finiteDiff = [0, 1, 2].map((i) => (plus[i] - minus[i]) / (2 * h));
  closeVec(velocity, finiteDiff, 1e-6);
});

test('rotateState requires et for a non-inertial frame', () => {
  const pool = fkPoolWithBinaryPckFrame(new KernelPool());
  const id = frameId('MOON_PA_DE440', pool);
  assert.throws(() => rotateState(id, frameId('J2000'), [1, 2, 3], [0, 0, 0], undefined, pool), /et\) is required/);
});

// --- class 2: built-in body-fixed frame (IAU_<BODY>) via the classic text-PCK formula ---

test('rotateState resolves a built-in body-fixed frame (IAU_MARS) via the classic formula', () => {
  const pool = new KernelPool();
  pool.putValues('BODY499_POLE_RA', [317.269202, -0.10927547, 0]);
  pool.putValues('BODY499_POLE_DEC', [54.432516, -0.05827105, 0]);
  pool.putValues('BODY499_PM', [176.049863, 350.891982443297, 0]);

  const id = frameId('IAU_MARS', pool);
  const et = 12345678;
  const bodyFixedPoint = [1, 0, 0];
  const { position } = rotateState(id, frameId('J2000'), bodyFixedPoint, [0, 0, 0], et, pool);
  // A pure rotation preserves length.
  const norm = (v) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
  assert.ok(Math.abs(norm(position) - 1) < 1e-9);
  // Round trip.
  const back = rotateState(frameId('J2000'), id, position, [0, 0, 0], et, pool);
  closeVec(back.position, bodyFixedPoint, 1e-9);
});

// --- class 4: TK (fixed-offset) frames ---

function fkPoolWithTkFrame(pool) {
  // MOON_ME_DE440_ME421 (31009), fixed offset relative to MOON_PA_DE440 (31008).
  fkPoolWithBinaryPckFrame(pool);
  pool.putValues('FRAME_MOON_ME_DE440_ME421', 31009);
  pool.putValues('FRAME_31009_NAME', 'MOON_ME_DE440_ME421');
  pool.putValues('FRAME_31009_CLASS', 4);
  pool.putValues('FRAME_31009_CENTER', 301);
  pool.putValues('TKFRAME_31009_SPEC', 'ANGLES');
  pool.putValues('TKFRAME_31009_RELATIVE', 'MOON_PA_DE440');
  pool.putValues('TKFRAME_31009_ANGLES', [67.8526, 78.6944, 0.2785]);
  pool.putValues('TKFRAME_31009_AXES', [3, 2, 1]);
  pool.putValues('TKFRAME_31009_UNITS', 'ARCSECONDS');
  return pool;
}

test('rotateState resolves a class 4 (TK, fixed-offset) frame relative to a class 2 frame', () => {
  const pool = fkPoolWithTkFrame(new KernelPool());
  const meId = frameId('MOON_ME_DE440_ME421', pool);
  const paId = frameId('MOON_PA_DE440', pool);
  assert.equal(meId, 31009);

  const et = 900;
  const point = [1000, 2000, 3000];
  // Directly to J2000, and via the relative (PA) frame -- must agree.
  const direct = rotateState(meId, frameId('J2000'), point, [0, 0, 0], et, pool);
  const toPa = rotateState(meId, paId, point, [0, 0, 0], et, pool);
  const paToJ2000 = rotateState(paId, frameId('J2000'), toPa.position, toPa.velocity, et, pool);
  closeVec(direct.position, paToJ2000.position, 1e-9);
  closeVec(direct.velocity, paToJ2000.velocity, 1e-9);
});

test('rotateState for a TK frame is time-independent relative to its own relative frame (a fixed offset)', () => {
  const pool = fkPoolWithTkFrame(new KernelPool());
  const meId = frameId('MOON_ME_DE440_ME421', pool);
  const paId = frameId('MOON_PA_DE440', pool);
  const point = [1, 0, 0];
  const a = rotateState(meId, paId, point, [0, 0, 0], 100, pool).position;
  const b = rotateState(meId, paId, point, [0, 0, 0], 900, pool).position;
  closeVec(a, b, 1e-12); // no time dependence between a TK frame and its own relative frame
});

test('rotateState round-trips through a class 4 frame (inverse rotation undoes it)', () => {
  const pool = fkPoolWithTkFrame(new KernelPool());
  const meId = frameId('MOON_ME_DE440_ME421', pool);
  const et = 500;
  const position = [1234, -567, 89];
  const velocity = [1, -2, 3];
  const toJ2000 = rotateState(meId, frameId('J2000'), position, velocity, et, pool);
  const back = rotateState(frameId('J2000'), meId, toJ2000.position, toJ2000.velocity, et, pool);
  closeVec(back.position, position, 1e-6);
  closeVec(back.velocity, velocity, 1e-9);
});

// Regression: frameId()/frameCenter()/rotateState() used to default
// `pool` to `null` instead of the global pool, unlike bodyCode() and
// every other pool-taking export -- meaning `furnsh()`-ing a frame
// kernel (into the default global pool, as furnsh() itself defaults
// to) and then calling frameId('SOME_FK_FRAME') with no explicit pool
// argument would report the frame as unrecognized.
test('frameId/frameCenter/rotateState default to the global pool, like every other pool-taking export', () => {
  const fkPath = path.join(os.tmpdir(), `spicejs-test-fk-${process.pid}.tf`);
  fs.writeFileSync(
    fkPath,
    "KPL/FK\n\\begindata\nFRAME_DEMO_FIXED = 91000\nFRAME_91000_NAME = 'DEMO_FIXED'\n" +
      "FRAME_91000_CLASS = 4\nFRAME_91000_CENTER = 399\nTKFRAME_91000_SPEC = 'MATRIX'\n" +
      'TKFRAME_91000_RELATIVE = \'J2000\'\nTKFRAME_91000_MATRIX = ( 1 0 0 0 1 0 0 0 1 )\n\\begintext\n'
  );
  try {
    furnsh(fkPath); // defaults to globalPool, same as spkez()/spkezr()
    const id = frameId('DEMO_FIXED'); // no explicit pool argument
    assert.equal(id, 91000);
    assert.equal(frameCenter(id), 399);
    const { position } = rotateState(id, frameId('J2000'), [1, 2, 3], [0, 0, 0], 0);
    closeVec(position, [1, 2, 3], 1e-12);
  } finally {
    fs.unlinkSync(fkPath);
    kclear(globalPool);
  }
});
