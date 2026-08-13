import test from 'node:test';
import assert from 'node:assert/strict';
import { stumpffFunctions } from '../src/math/stumpff.js';

function closeTo(a, b, tol = 1e-12) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

test('stumpffFunctions(0) equals the exact 1/k! values', () => {
  const { c0, c1, c2, c3 } = stumpffFunctions(0);
  closeTo(c0, 1);
  closeTo(c1, 1);
  closeTo(c2, 0.5);
  closeTo(c3, 1 / 6);
});

// stmp03.c's own doc comment gives this closed-form check for x > 0.
test('stumpffFunctions matches the closed trigonometric form for x > 1', () => {
  for (const x of [2, 5, 10, 39.5]) {
    const { c0, c1, c2, c3 } = stumpffFunctions(x);
    const root = Math.sqrt(x);
    closeTo(c0, Math.cos(root));
    closeTo(c1, Math.sin(root) / root);
    closeTo(c2, (1 - Math.cos(root)) / x);
    closeTo(c3, (1 - Math.sin(root) / root) / x);
  }
});

test('stumpffFunctions matches the closed hyperbolic form for x < -1', () => {
  for (const x of [-2, -5, -10, -39.5]) {
    const { c0, c1, c2, c3 } = stumpffFunctions(x);
    const root = Math.sqrt(-x);
    closeTo(c0, Math.cosh(root));
    closeTo(c1, Math.sinh(root) / root);
    closeTo(c2, (1 - Math.cosh(root)) / x);
    closeTo(c3, (1 - Math.sinh(root) / root) / x);
  }
});

test('stumpffFunctions is continuous across the |x| = 1 branch boundary', () => {
  const h = 1e-6;
  for (const boundary of [1, -1]) {
    // "inside" = the series branch (|x| <= 1), "outside" = the closed-form branch (|x| > 1).
    const inside = stumpffFunctions(boundary - Math.sign(boundary) * h);
    const outside = stumpffFunctions(boundary + Math.sign(boundary) * h);
    closeTo(inside.c0, outside.c0, 1e-5);
    closeTo(inside.c1, outside.c1, 1e-5);
    closeTo(inside.c2, outside.c2, 1e-5);
    closeTo(inside.c3, outside.c3, 1e-5);
  }
});

test('stumpffFunctions satisfies the exact recursion x*C_{k+2}(x) = 1/k! - C_k(x)', () => {
  for (const x of [-15, -0.7, 0, 0.3, 4, 22]) {
    const { c0, c1, c2, c3 } = stumpffFunctions(x);
    closeTo(x * c2, 1 - c0, 1e-9); // k=0: 1/0! = 1
    closeTo(x * c3, 1 - c1, 1e-9); // k=1: 1/1! = 1
  }
});
