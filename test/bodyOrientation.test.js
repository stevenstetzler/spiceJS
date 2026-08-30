import test from 'node:test';
import assert from 'node:assert/strict';
import { classicEulerAngles } from '../src/bodyOrientation.js';
import { KernelPool } from '../src/pool.js';

const DEG = Math.PI / 180;
const DAY = 86400;
const CENTURY = DAY * 36525;

function closeTo(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} to be close to ${expected}`);
}

test('classicEulerAngles: quadratic-only body (no periodic terms)', () => {
  const pool = new KernelPool();
  pool.putValues('BODY499_POLE_RA', [317.269202, -0.10927547, 0]);
  pool.putValues('BODY499_POLE_DEC', [54.432516, -0.05827105, 0]);
  pool.putValues('BODY499_PM', [176.049863, 350.891982443297, 0]);

  const et = 10 * CENTURY; // 10 Julian centuries past J2000
  const d = et / DAY;
  const t = et / CENTURY;
  const { ra, dec, w } = classicEulerAngles(499, et, pool);
  closeTo(ra, (317.269202 - 0.10927547 * t) * DEG);
  closeTo(dec, (54.432516 - 0.05827105 * t) * DEG);
  closeTo(w, (176.049863 + 350.891982443297 * d) * DEG);

  // Derivatives (analytic, since there's no periodic term): d(ra)/dt
  // is just the linear coefficient, converted from deg/century to rad/s.
  const { dra, ddec, dw } = classicEulerAngles(499, et, pool);
  closeTo(dra, (-0.10927547 * DEG) / CENTURY);
  closeTo(ddec, (-0.05827105 * DEG) / CENTURY);
  closeTo(dw, (350.891982443297 * DEG) / DAY);
});

test('classicEulerAngles: periodic terms via the parent barycenter (like BODY301/BODY3)', () => {
  const pool = new KernelPool();
  // A satellite (id 401, parent barycenter 4) with one periodic term.
  pool.putValues('BODY401_POLE_RA', [300, 0, 0]);
  pool.putValues('BODY401_POLE_DEC', [50, 0, 0]);
  pool.putValues('BODY401_PM', [10, 100, 0]);
  pool.putValues('BODY401_NUT_PREC_RA', [1.5]);
  pool.putValues('BODY401_NUT_PREC_DEC', [0.5]);
  pool.putValues('BODY401_NUT_PREC_PM', [0.25]);
  // Parent (barycenter 4)'s phase angle: theta = 20 + 40*t (degrees, t in Julian centuries).
  pool.putValues('BODY4_NUT_PREC_ANGLES', [20, 40]);

  const et = 0.1 * CENTURY;
  const d = et / DAY;
  const t = et / CENTURY;
  const thetaDeg = 20 + 40 * t;
  const thetaRad = thetaDeg * DEG;

  const { ra, dec, w, dra, ddec, dw } = classicEulerAngles(401, et, pool);
  closeTo(ra, (300 + 1.5 * Math.sin(thetaRad)) * DEG);
  closeTo(dec, (50 + 0.5 * Math.cos(thetaRad)) * DEG);
  closeTo(w, (10 + 100 * d + 0.25 * Math.sin(thetaRad)) * DEG);

  // Derivatives via a central finite difference against the formula
  // itself -- an independent check of the analytic product-rule code.
  const h = 1; // 1 second
  const plus = classicEulerAngles(401, et + h, pool);
  const minus = classicEulerAngles(401, et - h, pool);
  closeTo(dra, (plus.ra - minus.ra) / (2 * h), 1e-12);
  closeTo(ddec, (plus.dec - minus.dec) / (2 * h), 1e-12);
  closeTo(dw, (plus.w - minus.w) / (2 * h), 1e-12);
});

test('classicEulerAngles: throws a clear error when no orientation data is loaded', () => {
  const pool = new KernelPool();
  assert.throws(() => classicEulerAngles(499, 0, pool), /no BODY499_POLE_RA in the kernel pool/);
});

test('classicEulerAngles: throws when more phase angles are needed than the parent defines', () => {
  const pool = new KernelPool();
  pool.putValues('BODY401_POLE_RA', [300, 0, 0]);
  pool.putValues('BODY401_NUT_PREC_RA', [1.5, 0.5]); // needs 2 phase angles
  pool.putValues('BODY4_NUT_PREC_ANGLES', [20, 40]); // only defines 1
  assert.throws(() => classicEulerAngles(401, 0, pool), /needs 2 phase angles/);
});
