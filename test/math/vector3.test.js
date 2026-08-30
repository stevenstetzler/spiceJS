import test from 'node:test';
import assert from 'node:assert/strict';
import { add, sub, scale, dot, cross, norm, unit, rotateAboutAxis } from '../../src/math/vector3.js';

function closeVec(a, b, tol = 1e-9) {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < tol, `component ${i}: expected ${a} to be close to ${b}`);
  }
}

test('add / sub / scale', () => {
  assert.deepEqual(add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  assert.deepEqual(sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
  assert.deepEqual(scale([1, -2, 3], 2), [2, -4, 6]);
});

test('dot / cross / norm', () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
  assert.deepEqual(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.equal(norm([3, 4, 0]), 5);
});

test('unit vector has norm 1 and the original direction', () => {
  const u = unit([3, 4, 0]);
  closeVec(u, [0.6, 0.8, 0]);
  assert.ok(Math.abs(norm(u) - 1) < 1e-12);
});

test('rotateAboutAxis: 90 degrees about +Z takes +X to +Y', () => {
  closeVec(rotateAboutAxis([1, 0, 0], [0, 0, 1], Math.PI / 2), [0, 1, 0]);
});

test('rotateAboutAxis: 180 degrees about +Z takes +X to -X', () => {
  closeVec(rotateAboutAxis([1, 0, 0], [0, 0, 1], Math.PI), [-1, 0, 0]);
});

test('rotateAboutAxis: rotating about a vector parallel to v leaves v unchanged', () => {
  closeVec(rotateAboutAxis([2, 0, 0], [5, 0, 0], 1.234), [2, 0, 0]);
});

test('rotateAboutAxis: zero axis leaves v unchanged', () => {
  assert.deepEqual(rotateAboutAxis([1, 2, 3], [0, 0, 0], 1), [1, 2, 3]);
});

test('rotateAboutAxis: axis need not be unit length', () => {
  closeVec(rotateAboutAxis([1, 0, 0], [0, 0, 100], Math.PI / 2), [0, 1, 0]);
});
