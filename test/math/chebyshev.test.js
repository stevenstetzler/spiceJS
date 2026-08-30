import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateWithDerivative } from '../../src/math/chebyshev.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

test('T_k(s) values match their closed forms', () => {
  const s = 0.5;
  closeTo(evaluate([1], s), 1); // T0 = 1
  closeTo(evaluate([0, 1], s), s); // T1 = s
  closeTo(evaluate([0, 0, 1], s), 2 * s * s - 1); // T2 = 2s^2 - 1
  closeTo(evaluate([0, 0, 0, 1], s), 4 * s ** 3 - 3 * s); // T3 = 4s^3 - 3s
});

test('evaluate() sums a mixed series correctly', () => {
  const coeffs = [3, -2, 0.5, 1.25];
  const s = 0.3;
  const expected =
    3 * 1 + -2 * s + 0.5 * (2 * s * s - 1) + 1.25 * (4 * s ** 3 - 3 * s);
  closeTo(evaluate(coeffs, s), expected);
});

test('evaluate() and evaluateWithDerivative() agree on value', () => {
  const coeffs = [3, -2, 0.5, 1.25, -0.75];
  for (const s of [-0.9, -0.2, 0, 0.4, 0.99]) {
    const { value } = evaluateWithDerivative(coeffs, s);
    closeTo(value, evaluate(coeffs, s));
  }
});

test('evaluateWithDerivative() matches a central-difference numerical derivative', () => {
  const coeffs = [3, -2, 0.5, 1.25, -0.75, 0.1];
  const h = 1e-6;
  for (const s of [-0.8, -0.1, 0.2, 0.7]) {
    const { derivative } = evaluateWithDerivative(coeffs, s);
    const numerical = (evaluate(coeffs, s + h) - evaluate(coeffs, s - h)) / (2 * h);
    assert.ok(Math.abs(derivative - numerical) < 1e-6, `s=${s}: got ${derivative}, expected ~${numerical}`);
  }
});

test('single-coefficient series has zero derivative', () => {
  const { value, derivative } = evaluateWithDerivative([7], 0.3);
  assert.equal(value, 7);
  assert.equal(derivative, 0);
});
