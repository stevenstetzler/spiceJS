import test from 'node:test';
import assert from 'node:assert/strict';
import { prop2b } from '../src/prop2b.js';

function closeTo(a, b, tol) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

function closeVec(a, b, tol) {
  for (let i = 0; i < a.length; i++) closeTo(a[i], b[i], tol);
}

// prop2b.c's own $Examples #2: a circular orbit, propagated by
// exactly half its period, should equal -pvinit exactly (independent
// of prop2b's own algorithm -- this is basic circular-orbit
// geometry: half a period later, the object is diametrically
// opposite, moving the opposite direction).
test('prop2b matches NAIF prop2b.c\'s own circular-orbit half-period worked example', () => {
  const gm = 3.9860043543609598e5;
  const r = 1.0e8;
  const speed = Math.sqrt(gm / r);
  const pvinit = [0, r / Math.sqrt(2), r / Math.sqrt(2), 0, -speed / Math.sqrt(2), speed / Math.sqrt(2)];
  const halfPeriod = (Math.PI * r) / speed;

  const state = prop2b(gm, pvinit, halfPeriod);
  closeVec(state, pvinit.map((v) => -v), 1e-3); // km-scale positions, tight relative tolerance
});

test('prop2b: a full circular orbit period returns to the start', () => {
  const gm = 3.9860043543609598e5;
  const r = 1.0e8;
  const speed = Math.sqrt(gm / r);
  const pvinit = [r, 0, 0, 0, speed, 0];
  const period = (2 * Math.PI * r) / speed;

  const state = prop2b(gm, pvinit, period);
  closeVec(state, pvinit, 1e-2);
});

test('prop2b: propagating by 0 seconds returns the input unchanged', () => {
  const pvinit = [1e7, 2e6, -3e6, 1, -2, 0.5];
  const state = prop2b(398600.4418, pvinit, 0);
  assert.deepEqual(state, pvinit);
});

test('prop2b: propagating forward then backward by the same amount round-trips', () => {
  const gm = 398600.4418;
  const pvinit = [7000, 0, 0, 0, 7.5, 1];
  const dt = 12345;
  const forward = prop2b(gm, pvinit, dt);
  const back = prop2b(gm, forward, -dt);
  closeVec(back, pvinit, 1e-4);
});

test('prop2b: a circular orbit stays at constant radius and speed throughout', () => {
  const gm = 398600.4418;
  const r = 42164; // geostationary-ish radius
  const speed = Math.sqrt(gm / r);
  const pvinit = [r, 0, 0, 0, speed, 0];
  for (const dt of [100, 5000, -5000, 40000]) {
    const [x, y, z, vx, vy, vz] = prop2b(gm, pvinit, dt);
    closeTo(Math.hypot(x, y, z), r, 1e-6);
    closeTo(Math.hypot(vx, vy, vz), speed, 1e-9);
  }
});

function specificAngularMomentum([x, y, z, vx, vy, vz]) {
  return [y * vz - z * vy, z * vx - x * vz, x * vy - y * vx];
}

function visVivaEnergy(gm, [x, y, z, vx, vy, vz]) {
  const r = Math.hypot(x, y, z);
  const v2 = vx * vx + vy * vy + vz * vz;
  return v2 / 2 - gm / r; // specific orbital energy
}

// Independent physical invariants (not tied to prop2b's own internal
// formulas): two-body motion conserves specific angular momentum and
// vis-viva (specific orbital) energy at every point along the orbit.
test('prop2b: an eccentric orbit conserves angular momentum and vis-viva energy', () => {
  const gm = 398600.4418;
  const pvinit = [8000, 0, 0, 0, 6.5, 3.0]; // an eccentric orbit
  const h0 = specificAngularMomentum(pvinit);
  const energy0 = visVivaEnergy(gm, pvinit);

  for (const dt of [500, 8000, -3000, 20000]) {
    const state = prop2b(gm, pvinit, dt);
    const h = specificAngularMomentum(state);
    closeVec(h, h0, 1e-6 * Math.hypot(...h0));
    closeTo(visVivaEnergy(gm, state), energy0, 1e-8 * Math.abs(energy0));
  }
});

test('prop2b throws for rectilinear motion (zero angular momentum)', () => {
  // Purely radial position/velocity -- pos x vel = 0.
  assert.throws(() => prop2b(398600.4418, [1e7, 0, 0, 1, 0, 0], 100), /rectilinear/);
});

test('prop2b throws for a non-positive gm', () => {
  assert.throws(() => prop2b(0, [1e7, 0, 0, 0, 1, 0], 100), /gm must be positive/);
  assert.throws(() => prop2b(-1, [1e7, 0, 0, 0, 1, 0], 100), /gm must be positive/);
});
