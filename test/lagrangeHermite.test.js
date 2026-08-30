import test from 'node:test';
import assert from 'node:assert/strict';
import { lagrangeInterpolate, hermiteInterpolate } from '../src/math/lagrangeHermite.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

// NAIF's own worked example, straight from hrmint.c's doc comment: fit
// the unique degree-7 polynomial through these (x, y, y') triples and
// evaluate at x=2 -- answer 141.0, derivative 456.0. Independently
// checked: the closed form is f(x) = x^7 + 2x^2 + 5, f(2) = 128+8+5 =
// 141, f'(x) = 7x^6 + 4x, f'(2) = 448+8 = 456.
const HRMINT_EXAMPLE = {
  xs: [-1, 0, 3, 5],
  ys: [6, 5, 2210, 78180],
  dys: [3, 0, 5115, 109395],
};

test('hermiteInterpolate matches NAIF hrmint.c\'s own worked example exactly', () => {
  const { value, derivative } = hermiteInterpolate(HRMINT_EXAMPLE.xs, HRMINT_EXAMPLE.ys, HRMINT_EXAMPLE.dys, 2);
  closeTo(value, 141.0, 1e-8);
  closeTo(derivative, 456.0, 1e-8);
});

test('hermiteInterpolate reproduces the exact closed form f(x) = x^7 + 2x^2 + 5 at other points too', () => {
  const f = (x) => x ** 7 + 2 * x ** 2 + 5;
  const df = (x) => 7 * x ** 6 + 4 * x;
  for (const x of [-1, 0, 1, 2.5, 3, 4.7, 5]) {
    const { value, derivative } = hermiteInterpolate(HRMINT_EXAMPLE.xs, HRMINT_EXAMPLE.ys, HRMINT_EXAMPLE.dys, x);
    closeTo(value, f(x), 1e-6);
    closeTo(derivative, df(x), 1e-6);
  }
});

test('hermiteInterpolate works with non-uniformly spaced nodes', () => {
  // f(x) = x^3, f'(x) = 3x^2, nodes deliberately irregular.
  const xs = [-3, -0.5, 1, 1.2, 4];
  const ys = xs.map((x) => x ** 3);
  const dys = xs.map((x) => 3 * x ** 2);
  for (const x of [-2, 0, 1.1, 2, 3.9]) {
    const { value, derivative } = hermiteInterpolate(xs, ys, dys, x);
    closeTo(value, x ** 3, 1e-6);
    closeTo(derivative, 3 * x ** 2, 1e-6);
  }
});

test('hermiteInterpolate rejects duplicate abscissas', () => {
  assert.throws(() => hermiteInterpolate([0, 0, 1], [1, 1, 2], [0, 0, 0], 0.5), /duplicate abscissa/);
});

test('lagrangeInterpolate reconstructs a linear function exactly, evenly or unevenly spaced', () => {
  const f = (x) => 3 + 2 * x;
  for (const xs of [[0, 1, 2, 3], [-5, -1, 0, 7, 20]]) {
    const ys = xs.map(f);
    for (const x of [-10, 0, 0.5, 4.2, 15]) {
      closeTo(lagrangeInterpolate(xs, ys, x), f(x), 1e-9);
    }
  }
});

test('lagrangeInterpolate reconstructs a higher-degree polynomial exactly with enough nodes', () => {
  const f = (x) => x ** 4 - 3 * x ** 3 + 2 * x - 1;
  const xs = [-2, -1, 0, 1, 2]; // 5 nodes -> exact for degree <= 4
  const ys = xs.map(f);
  for (const x of [-1.5, 0.3, 1.9, 3]) {
    closeTo(lagrangeInterpolate(xs, ys, x), f(x), 1e-7);
  }
});

test('lagrangeInterpolate rejects duplicate abscissas', () => {
  assert.throws(() => lagrangeInterpolate([0, 1, 1], [1, 2, 3], 0.5), /duplicate abscissa/);
});

test('lagrangeInterpolate/hermiteInterpolate reject mismatched array lengths', () => {
  assert.throws(() => lagrangeInterpolate([0, 1], [1], 0.5), /same non-zero length/);
  assert.throws(() => hermiteInterpolate([0, 1], [1, 2], [0], 0.5), /same non-zero length/);
});
