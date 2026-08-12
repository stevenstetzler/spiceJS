import test from 'node:test';
import assert from 'node:assert/strict';
import { frameId, rotateState } from '../src/frames.js';

function closeVec(a, b, tol = 1e-9) {
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < tol, `component ${i}: expected ${a} to be close to ${b}`);
  }
}

test('frameId resolves known built-in inertial frames, case-insensitively', () => {
  assert.equal(frameId('J2000'), 1);
  assert.equal(frameId('j2000'), 1);
  assert.equal(frameId('B1950'), 2);
  assert.equal(frameId('ECLIPJ2000'), 17);
  assert.equal(frameId('GALACTIC'), 13);
});

test('frameId rejects unknown/body-fixed frame names', () => {
  assert.throws(() => frameId('IAU_MARS'), /body-fixed frames.*aren't supported yet/);
  assert.throws(() => frameId('NOT_A_FRAME'), /not one of the built-in inertial frames/);
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
