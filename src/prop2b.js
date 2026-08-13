/**
 * PROP2B: propagate a state under pure two-body (Keplerian) motion by
 * `dt` seconds, using the universal-variables formulation (works
 * uniformly across elliptical/parabolic/hyperbolic orbits, unlike a
 * classical Kepler's-equation solution). Faithfully translated from
 * NAIF's prop2b.c/stmp03.c (Danby, "Fundamentals of Celestial
 * Mechanics," 2nd ed., pp 168-180), not re-derived independently --
 * see the doc comments below for the exact formulas, all confirmed
 * against source.
 *
 * Deliberately not ported: prop2b.c's memoization of intermediate
 * results across repeated calls with the same GM/initial state -- a
 * pure performance optimization (this always recomputes from
 * scratch), not part of the mathematical result.
 */
import { add, sub, scale, cross, dot, norm } from './math/vector3.js';
import { stumpffFunctions } from './math/stumpff.js';

const DPMAX = Number.MAX_VALUE;

function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

/** KFUN(x) = x*(br0*C1 + x*(b2rv*C2 + x*bq*C3)), evaluated at Stumpff argument f*x^2. */
function kfunAt(x, f, br0, b2rv, bq) {
  const { c0, c1, c2, c3 } = stumpffFunctions(f * x * x);
  return { kfun: x * (br0 * c1 + x * (b2rv * c2 + x * bq * c3)), c0, c1, c2, c3 };
}

/**
 * The numeric domain [-bound, bound] within which every term of
 * KFUN(x) (and the final state formula) is guaranteed representable
 * in a float64, derived from the magnitude of its coefficients --
 * see prop2b.c's Particulars for the derivation (differs for
 * hyperbolic (f < 0) vs. elliptical/parabolic (f >= 0) orbits).
 */
function domainBound(f, br0, b2rv, bq, qovr0) {
  const maxc = Math.max(1, Math.abs(br0), Math.abs(b2rv), Math.abs(bq), Math.abs(qovr0 / bq));
  const logMaxc = Math.log(maxc);
  if (f < 0) {
    const fixed = Math.log(DPMAX / 2) - logMaxc;
    const rootf = Math.sqrt(-f);
    const logf = Math.log(-f);
    return Math.min(fixed / rootf, (fixed + 1.5 * logf) / rootf);
  }
  const logbnd = (Math.log(1.5) + Math.log(DPMAX) - logMaxc) / 3;
  return Math.exp(logbnd);
}

/**
 * Propagate the state `pvinit = [x,y,z,vx,vy,vz]` (km, km/s) forward
 * (or backward, for negative `dt`) by `dt` seconds under two-body
 * motion about a center with gravitational parameter `gm` (km^3/s^2).
 *
 * @param {number} gm
 * @param {number[]} pvinit - `[x, y, z, vx, vy, vz]`
 * @param {number} dt - seconds
 * @returns {number[]} `[x, y, z, vx, vy, vz]` at the propagated epoch
 */
export function prop2b(gm, pvinit, dt) {
  if (!(gm > 0)) {
    throw new Error(`prop2b: gm must be positive, got ${gm}`);
  }
  const pos = pvinit.slice(0, 3);
  const vel = pvinit.slice(3, 6);

  const r0 = norm(pos);
  const rv = dot(pos, vel);
  const hvec = cross(pos, vel);
  const h2 = dot(hvec, hvec);
  if (h2 === 0) {
    throw new Error('prop2b: motion is rectilinear (zero angular momentum) -- cannot propagate a conic orbit');
  }

  // Eccentricity vector: e*qvec = (vel x hvec)/gm - pos/r0.
  const eqvec = sub(scale(cross(vel, hvec), 1 / gm), scale(pos, 1 / r0));
  const e = norm(eqvec);
  const q = h2 / (gm * (e + 1)); // periapsis distance
  const f = 1 - e;
  const b = Math.sqrt(q / gm);
  const br0 = b * r0;
  const b2rv = b * b * rv;
  const bq = b * q;
  const qovr0 = q / r0;

  if (dt === 0) return pvinit.slice();

  const bound = domainBound(f, br0, b2rv, bq, qovr0);

  let x = clamp(dt / bq, -bound, bound);
  let { kfun, c0, c1, c2, c3 } = kfunAt(x, f, br0, b2rv, bq);

  let lower;
  let upper;
  const rangeError = () =>
    new Error(
      `prop2b: dt=${dt} is outside the range this GM/initial state can be reliably propagated over ` +
        '(bracket search hit the numeric domain boundary)'
    );

  if (dt < 0) {
    upper = 0;
    lower = x;
    while (kfun > dt) {
      upper = lower;
      lower *= 2;
      const oldX = x;
      x = clamp(lower, -bound, bound);
      if (x === oldX) throw rangeError();
      ({ kfun, c0, c1, c2, c3 } = kfunAt(x, f, br0, b2rv, bq));
    }
  } else {
    lower = 0;
    upper = x;
    while (kfun < dt) {
      lower = upper;
      upper *= 2;
      const oldX = x;
      x = clamp(upper, -bound, bound);
      if (x === oldX) throw rangeError();
      ({ kfun, c0, c1, c2, c3 } = kfunAt(x, f, br0, b2rv, bq));
    }
  }

  // Root is bracketed in [lower, upper] (kfun is monotonic increasing) -- bisect.
  x = clamp((lower + upper) / 2, lower, upper);
  ({ c0, c1, c2, c3 } = kfunAt(x, f, br0, b2rv, bq));
  let iterations = 0;
  let maxIterations = 1000;
  while (x > lower && x < upper && iterations < maxIterations) {
    ({ kfun, c0, c1, c2, c3 } = kfunAt(x, f, br0, b2rv, bq));
    if (kfun > dt) upper = x;
    else if (kfun < dt) lower = x;
    else {
      upper = x;
      lower = x;
    }
    // Once the bracket has moved off zero, 64 bisections is always
    // enough to converge to machine precision -- tighten the cap
    // (matches prop2b.c exactly, including resetting the counter).
    if (maxIterations > 64 && upper !== 0 && lower !== 0) {
      maxIterations = 64;
      iterations = 0;
    }
    x = clamp((lower + upper) / 2, lower, upper);
    iterations++;
  }
  ({ c0, c1, c2, c3 } = kfunAt(x, f, br0, b2rv, bq));

  const x2 = x * x;
  const x3 = x2 * x;
  const br = br0 * c0 + x * (b2rv * c1 + x * bq * c2);
  const pc = 1 - qovr0 * x2 * c2;
  const vc = dt - bq * x3 * c3;
  const pcdot = -(qovr0 / br) * x * c1;
  const vcdot = 1 - (bq / br) * x2 * c2;

  const newPos = add(scale(pos, pc), scale(vel, vc));
  const newVel = add(scale(pos, pcdot), scale(vel, vcdot));
  return [...newPos, ...newVel];
}
