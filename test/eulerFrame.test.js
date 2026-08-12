import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axisRotation,
  composeAxisRotations,
  composeAxisRotationsWithDerivative,
  tipmFromEulerAngles,
  transpose3,
} from '../src/math/eulerFrame.js';

function closeVec(a, b, tol = 1e-9) {
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < tol, `component ${i}: expected ${a} to be close to ${b}`);
  }
}

function closeMat(a, b, tol = 1e-9) {
  for (let i = 0; i < 3; i++) closeVec(a[i], b[i], tol);
}

function multiplyVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

test('axisRotation matches NAIF ROTATE for axis 3 (a known worked example)', () => {
  // ROTATE's own $Examples: ROTATE(PI/4, 3, MOUT) -> [[s2,s2,0],[-s2,s2,0],[0,0,1]], s2=sqrt(2)/2.
  const s2 = Math.SQRT1_2;
  closeMat(axisRotation(3, Math.PI / 4), [
    [s2, s2, 0],
    [-s2, s2, 0],
    [0, 0, 1],
  ]);
});

test('axisRotation is orthogonal (a rotation preserves vector length)', () => {
  for (const axis of [1, 2, 3]) {
    const m = axisRotation(axis, 0.7);
    const v = multiplyVec(m, [1, 2, 3]);
    const norm = (x) => Math.sqrt(x[0] ** 2 + x[1] ** 2 + x[2] ** 2);
    assert.ok(Math.abs(norm(v) - norm([1, 2, 3])) < 1e-12);
  }
});

test('composeAxisRotations composes left-to-right (pairs[0] leftmost factor)', () => {
  const r3 = axisRotation(3, 0.3);
  const r1 = axisRotation(1, 0.5);
  const composed = composeAxisRotations([
    { axis: 3, theta: 0.3 },
    { axis: 1, theta: 0.5 },
  ]);
  // Expected: r3 * r1 (matrix product), checked by applying to a vector.
  const v = [1, 2, 3];
  const expected = multiplyVec(r3, multiplyVec(r1, v));
  closeVec(multiplyVec(composed, v), expected);
});

test('composeAxisRotationsWithDerivative matches composeAxisRotations for the matrix part', () => {
  const pairs = [
    { axis: 3, theta: 0.4, rate: 0.01 },
    { axis: 1, theta: -0.2, rate: 0.02 },
    { axis: 3, theta: 0.1, rate: -0.03 },
  ];
  const { matrix } = composeAxisRotationsWithDerivative(pairs);
  const expected = composeAxisRotations(pairs.map(({ axis, theta }) => ({ axis, theta })));
  closeMat(matrix, expected);
});

test('composeAxisRotationsWithDerivative matches a central finite difference in time', () => {
  const rates = [0.02, -0.05, 0.03];
  const at = (dt) =>
    composeAxisRotations([
      { axis: 3, theta: 0.4 + rates[0] * dt },
      { axis: 1, theta: -0.2 + rates[1] * dt },
      { axis: 3, theta: 0.1 + rates[2] * dt },
    ]);
  const { dmatrix } = composeAxisRotationsWithDerivative([
    { axis: 3, theta: 0.4, rate: rates[0] },
    { axis: 1, theta: -0.2, rate: rates[1] },
    { axis: 3, theta: 0.1, rate: rates[2] },
  ]);
  const h = 1e-6;
  const plus = at(h);
  const minus = at(-h);
  const finiteDiff = plus.map((row, i) => row.map((x, j) => (x - minus[i][j]) / (2 * h)));
  closeMat(dmatrix, finiteDiff, 1e-6);
});

test('tipmFromEulerAngles: TIPM is orthogonal and DTIPM matches a finite difference', () => {
  const phi = 0.7;
  const delta = 0.3;
  const w = 1.9;
  const dphi = 0.001;
  const ddelta = -0.002;
  const dw = 0.05;

  const { tipm, dtipm } = tipmFromEulerAngles(phi, delta, w, dphi, ddelta, dw);

  // Orthogonality: TIPM^T * TIPM = identity.
  const tipmT = transpose3(tipm);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const dot = tipmT[i][0] * tipm[0][j] + tipmT[i][1] * tipm[1][j] + tipmT[i][2] * tipm[2][j];
      assert.ok(Math.abs(dot - (i === j ? 1 : 0)) < 1e-12);
    }
  }

  const h = 1e-6;
  const at = (dt) =>
    tipmFromEulerAngles(phi + dphi * dt, delta + ddelta * dt, w + dw * dt, dphi, ddelta, dw).tipm;
  const plus = at(h);
  const minus = at(-h);
  const finiteDiff = plus.map((row, i) => row.map((x, j) => (x - minus[i][j]) / (2 * h)));
  closeMat(dtipm, finiteDiff, 1e-6);
});

test('tipmFromEulerAngles reduces to identity-rate-of-change when all rates are zero', () => {
  const { dtipm } = tipmFromEulerAngles(0.5, 0.2, 1.1, 0, 0, 0);
  closeMat(dtipm, [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
});
