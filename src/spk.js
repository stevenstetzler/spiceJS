/**
 * SPK: NAIF's binary trajectory (ephemeris) kernel format, built on
 * the generic DAF container (daf.js).
 *
 * An SPK summary has ND=2, NI=6:
 *   dc = [startEt, stopEt]                       (TDB seconds past J2000)
 *   ic = [target, center, frame, type, startAddr, endAddr]
 * `startAddr`/`endAddr` bound the segment's raw data as DAF addresses.
 *
 * Segment types 2/3 (Chebyshev polynomials -- these cover the vast
 * majority of publicly distributed planetary, lunar, and satellite
 * kernels), 8/9 (Lagrange), and 12/13 (Hermite) are supported. Types 2
 * and 3 share the same logical-record layout (confirmed against
 * NAIF's spkr02.c/spke02.c and spkr03.c/spke03.c):
 *
 *   segment = [record_0, record_1, ..., record_{N-1}, INIT, INTLEN, RSIZE, N]
 *   record  = [MID, RADIUS, coeffs...]
 *
 * `INIT`/`INTLEN`/`RSIZE`/`N` (the "epilog") are the last 4 doubles of
 * the segment and describe how to pick the right fixed-size record
 * for a given ET: `recno = floor((et - INIT) / INTLEN)`, clamped to
 * [0, N-1]. Within a record, position (and, for type 2, velocity) is
 * evaluated at `s = (et - MID) / RADIUS`, `s` in [-1, 1]:
 *
 *   - Type 2 (position only): `coeffs` is 3 back-to-back coefficient
 *     sets (X, Y, Z). Velocity is the analytic derivative of the
 *     position polynomial (chain rule: d/dt = (d/ds) / RADIUS) --
 *     this matches real SPICE's spke02_, which also returns a state
 *     even for "position only" data.
 *   - Type 3 (position + velocity): `coeffs` is 6 back-to-back sets
 *     (X, Y, Z, VX, VY, VZ) -- velocity is its own independently-fit
 *     polynomial, evaluated directly (no differentiation, no RADIUS
 *     scaling).
 *
 * Types 8/9 (Lagrange) and 12/13 (Hermite) -- interpolated, windowed
 * states rather than Chebyshev coefficients -- are also supported; see
 * math/interpolatedRecord.js (segment layout and window selection,
 * shared between the equal- and unequal-time-step pairs) and
 * math/lagrangeHermite.js (the interpolation itself, shared between
 * the equal- and unequal-spacing pairs -- NAIF's LGRESP/HRMESP are
 * just equal-spacing shortcuts of the same LGRINT/HRMINT algorithms).
 *
 * Type 5 (two-body/Keplerian propagation) is also supported -- unlike
 * every other type here, it's not an interpolation scheme: the
 * segment stores a handful of states, and evaluating it means
 * propagating the two bracketing states forward/backward to `et` via
 * two-body motion (prop2b.js) and blending them (see evaluateType5()
 * below). See math/interpolatedRecord.js's selectBracketingPair() for
 * the (shared-with-9/13) on-disk layout.
 *
 * Type 21 (extended difference lines / Modified Difference Arrays --
 * a generalized Type 1, the classic numerically-integrated-trajectory
 * format used for e.g. JPL Horizons small-body/comet SPKs) is also
 * supported. Its epoch/directory layout is the same family as 5/9/13
 * (math/interpolatedRecord.js's selectDifferenceLine()), but each
 * record is picked outright (the first one whose own *coverage end*
 * epoch is `>= et` -- not its reference epoch, and no window or
 * bracketing pair) and evaluated via its
 * own modified-divided-difference recurrence (math/differenceArray.js's
 * evaluateDifferenceLine()), not interpolated between neighbors.
 */
import { parseDaf } from './daf.js';
import { evaluate, evaluateWithDerivative } from './math/chebyshev.js';
import { selectRecord } from './math/chebyshevRecord.js';
import {
  selectEqualStepWindow,
  selectUnequalStepWindow,
  selectBracketingPair,
  selectDifferenceLine,
} from './math/interpolatedRecord.js';
import { evaluateDifferenceLine } from './math/differenceArray.js';
import { lagrangeInterpolate, hermiteInterpolate } from './math/lagrangeHermite.js';
import { add, sub, scale, cross, norm, unit, rotateAboutAxis } from './math/vector3.js';
import { globalPool } from './pool.js';
import { frameId as resolveFrameId, frameCenter, rotateState } from './frames.js';
import { bodyCode } from './bodies.js';
import { prop2b } from './prop2b.js';

const SPK_ND = 2;
const SPK_NI = 6;
const SUPPORTED_TYPES = new Set([2, 3, 5, 8, 9, 12, 13, 21]);

const CLIGHT_KM_S = 299792.458; // exact, by SI definition of the meter
const MAX_CHAIN_HOPS = 20; // matches NAIF's own CHLEN (spkgeo.f)
const SSB = 0;

/**
 * The pure `{dc, ic}` -> segment-descriptor field mapping SPK's
 * ND=2,NI=6 summary shape uses -- exported so `lazy/prefetch.js` can
 * interpret already-parsed summaries (from a lazily-fetched file's
 * structural metadata) exactly the same way `loadSpk()` below does,
 * without duplicating the field order.
 */
export function summaryToSpkSegment({ dc, ic }) {
  return {
    startEt: dc[0],
    stopEt: dc[1],
    target: ic[0],
    center: ic[1],
    frame: ic[2],
    type: ic[3],
    startAddr: ic[4],
    endAddr: ic[5],
  };
}

/**
 * Decode an SPK file's segments from its raw bytes. Each returned
 * segment carries its own `buffer`/`littleEndian` so it can be
 * evaluated independently of the file it came from.
 */
export function loadSpk(buffer) {
  const daf = parseDaf(buffer);
  // "NAIF/DAF" is a generic, older ID word real CSPICE still accepts
  // as SPK data (several of NAIF's own real distributed kernels, e.g.
  // the DSN station-position SPKs, use it) -- see kernels.js's furnsh()
  // for the shape-based (ND=2,NI=6) disambiguation from PCK/CK.
  if (!daf.idWord.startsWith('DAF/SPK') && !daf.idWord.startsWith('NAIF/DAF')) {
    throw new Error(`spk: not an SPK file (DAF ID word is "${daf.idWord}")`);
  }
  if (daf.nd !== SPK_ND || daf.ni !== SPK_NI) {
    throw new Error(`spk: unexpected summary shape ND=${daf.nd} NI=${daf.ni} (SPK requires ND=2, NI=6)`);
  }

  return daf.summaries.map((summary) => ({
    ...summaryToSpkSegment(summary),
    buffer,
    littleEndian: daf.littleEndian,
  }));
}

function evaluateType2(segment, et) {
  const record = selectRecord(segment, et);
  const mid = record[0];
  const radius = record[1];
  const ncoef = (record.length - 2) / 3;
  const s = (et - mid) / radius;

  const position = [];
  const velocity = [];
  for (let axis = 0; axis < 3; axis++) {
    const start = 2 + axis * ncoef;
    const coeffs = record.subarray(start, start + ncoef);
    const { value, derivative } = evaluateWithDerivative(coeffs, s);
    position.push(value);
    velocity.push(derivative / radius);
  }
  return { position, velocity };
}

function evaluateType3(segment, et) {
  const record = selectRecord(segment, et);
  const mid = record[0];
  const radius = record[1];
  const ncoef = (record.length - 2) / 6;
  const s = (et - mid) / radius;

  const position = [];
  const velocity = [];
  for (let axis = 0; axis < 3; axis++) {
    const start = 2 + axis * ncoef;
    position.push(evaluate(record.subarray(start, start + ncoef), s));
  }
  for (let axis = 0; axis < 3; axis++) {
    const start = 2 + (3 + axis) * ncoef;
    velocity.push(evaluate(record.subarray(start, start + ncoef), s));
  }
  return { position, velocity };
}

/** Types 8/9 (Lagrange): all 6 state components are independently sampled and interpolated (spke08.c). */
function evaluateLagrange(segment, et, selectWindow) {
  const { epochs, states } = selectWindow(segment, et);
  const position = [];
  const velocity = [];
  for (let axis = 0; axis < 6; axis++) {
    const ys = states.map((state) => state[axis]);
    const value = lagrangeInterpolate(epochs, ys, et);
    (axis < 3 ? position : velocity).push(value);
  }
  return { position, velocity };
}

/** Types 12/13 (Hermite): only x/y/z are interpolated -- each call also yields that axis's velocity (spke12.c). */
function evaluateHermite(segment, et, selectWindow) {
  const { epochs, states } = selectWindow(segment, et);
  const position = [];
  const velocity = [];
  for (let axis = 0; axis < 3; axis++) {
    const ys = states.map((state) => state[axis]);
    const dys = states.map((state) => state[axis + 3]);
    const { value, derivative } = hermiteInterpolate(epochs, ys, dys, et);
    position.push(value);
    velocity.push(derivative);
  }
  return { position, velocity };
}

/**
 * Type 5 (two-body propagation, spke05.c): propagate each of the two
 * bracketing states to `et` via prop2b, then blend with a cosine
 * weight `W(t) = 0.5 + 0.5*cos(pi*(t-t1)/(t2-t1))` that is 1 at `t1`
 * and 0 at `t2` (so the result is continuous with each endpoint's own
 * pure two-body propagation as `et` approaches it). `W`'s derivative
 * contributes an extra term to velocity via the product rule, since
 * `pos(t) = W(t)*p1(t) + (1-W(t))*p2(t)` is itself a function of `t`
 * through both the propagated states *and* the blend weight.
 *
 * At the segment's own start/end (selectBracketingPair's clamped,
 * repeated-epoch case, `t1 === t2`), there's nothing to blend --
 * `W` would be 0/0 -- so this just returns the single propagation.
 */
function evaluateType5(segment, et) {
  const { gm, epochs, states } = selectBracketingPair(segment, et);
  const [t1, t2] = epochs;

  if (t1 === t2) {
    const state = prop2b(gm, states[0], et - t1);
    return { position: state.slice(0, 3), velocity: state.slice(3, 6) };
  }

  const state1 = prop2b(gm, states[0], et - t1);
  const state2 = prop2b(gm, states[1], et - t2);

  const theta = (Math.PI * (et - t1)) / (t2 - t1);
  const w = 0.5 + 0.5 * Math.cos(theta);
  const dw = (-0.5 * Math.sin(theta) * Math.PI) / (t2 - t1);

  const position = [];
  const velocity = [];
  for (let axis = 0; axis < 3; axis++) {
    position.push(w * state1[axis] + (1 - w) * state2[axis]);
    velocity.push(w * state1[axis + 3] + (1 - w) * state2[axis + 3] + dw * (state1[axis] - state2[axis]));
  }
  return { position, velocity };
}

/** Type 21 (extended difference lines): select the one record covering `et`, then its own MDA recurrence. See math/differenceArray.js. */
function evaluateType21(segment, et) {
  const record = selectDifferenceLine(segment, et);
  return evaluateDifferenceLine(record, et);
}

/**
 * Evaluate a segment at `et` (TDB seconds past J2000), returning
 * `{ position: [x,y,z], velocity: [vx,vy,vz] }` in km and km/s, in
 * the segment's native reference frame (see `segment.frame`) -- no
 * frame transform is applied.
 */
export function evaluateSegment(segment, et) {
  switch (segment.type) {
    case 2:
      return evaluateType2(segment, et);
    case 3:
      return evaluateType3(segment, et);
    case 5:
      return evaluateType5(segment, et);
    case 8:
      return evaluateLagrange(segment, et, selectEqualStepWindow);
    case 9:
      return evaluateLagrange(segment, et, selectUnequalStepWindow);
    case 12:
      return evaluateHermite(segment, et, selectEqualStepWindow);
    case 13:
      return evaluateHermite(segment, et, selectUnequalStepWindow);
    case 21:
      return evaluateType21(segment, et);
    default:
      throw new Error(
        `spk: segment data type ${segment.type} is not supported yet (supported: 2, 3 -- Chebyshev; ` +
          '5 -- two-body propagation; 8, 9 -- Lagrange; 12, 13 -- Hermite; 21 -- extended difference lines)'
      );
  }
}

/**
 * Find the loaded segment giving `target`'s state relative to
 * `center` at `et`. This is a *direct* lookup: `target`/`center` must
 * match an existing segment's descriptor exactly -- unlike SPICE's
 * spkezr_c/spkgeo_c, this does not search across intermediate bodies
 * (e.g. it can read Mercury relative to the Solar System Barycenter
 * straight from a DE kernel, but not Mercury relative to Earth
 * without that chaining, which spiceJS does not implement yet).
 */
export function findSegment(pool, target, center, et) {
  const candidates = pool.getSpkSegments(target).filter((segment) => segment.center === center);
  if (candidates.length === 0) {
    const pairs = pool
      .allSpkSegments()
      .map((s) => `(${s.target}, ${s.center})`)
      .filter((pair, i, all) => all.indexOf(pair) === i);
    throw new Error(
      `spkState: no loaded SPK segment gives target ${target} relative to center ${center}. ` +
        (pairs.length
          ? `Loaded (target, center) pairs: ${pairs.join(', ')}.`
          : 'No SPK segments are loaded -- use furnsh() to load a .bsp file first.')
    );
  }
  const covering = candidates.find((segment) => et >= segment.startEt && et <= segment.stopEt);
  if (!covering) {
    const coverage = candidates.map((s) => `[${s.startEt}, ${s.stopEt}]`).join(', ');
    throw new RangeError(
      `spkState: target ${target} relative to center ${center} has no coverage at ET=${et}. ` +
        `Loaded coverage: ${coverage}.`
    );
  }
  return covering;
}

/**
 * The public entry point: `target`'s position and velocity relative
 * to `center` at `et` (TDB seconds past J2000), in km and km/s, in
 * whatever frame the segment natively uses (see spkSegments() to
 * inspect it). See findSegment()'s doc comment for the "direct lookup
 * only, no chaining" caveat.
 *
 * @param {number} target - target body ID (e.g. 499 for Mars)
 * @param {number} center - center/observer body ID (e.g. 0 for the
 *   Solar System Barycenter)
 * @param {number} et - ephemeris time, TDB seconds past J2000
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {{ position: number[], velocity: number[] }}
 */
export function spkState(target, center, et, pool = globalPool) {
  const segment = findSegment(pool, target, center, et);
  return evaluateSegment(segment, et);
}

/**
 * List every currently-loaded SPK segment's descriptor (target,
 * center, frame, type, and ET coverage) -- useful for introspection
 * and for discovering what (target, center) pairs are actually
 * available to query with spkState().
 *
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function spkSegments(pool = globalPool) {
  return pool.allSpkSegments().map(({ target, center, frame, type, startEt, stopEt }) => ({
    target,
    center,
    frame,
    type,
    startEt,
    stopEt,
  }));
}

/**
 * Among a body's loaded segments, the one covering `et` -- preferring
 * the *last-loaded* match, matching SPICE's own "most recently
 * furnsh'd kernel has priority" convention for overlapping data.
 */
function pickSegmentForBody(pool, bodyId, et) {
  const candidates = pool.getSpkSegments(bodyId).filter((segment) => et >= segment.startEt && et <= segment.stopEt);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * State of `bodyId` relative to the Solar System Barycenter (body 0)
 * at `et`: walk `.center` links, summing each hop's state, until
 * reaching body 0. This is what NAIF's spkssb_ does (it's literally
 * spkgeo_ with the observer fixed at body 0), and is the building
 * block spkez() below chains target and observer through.
 *
 * @returns {{ position: number[], velocity: number[], frame: number|null }}
 *   `frame` is `null` when `bodyId` is 0 itself (a trivial zero state,
 *   compatible with any frame).
 */
function chainStateToSsb(pool, bodyId, et) {
  let position = [0, 0, 0];
  let velocity = [0, 0, 0];
  let frame = null;
  let current = bodyId;
  const visited = new Set();

  while (current !== SSB) {
    if (visited.has(current)) {
      throw new Error(`spkez: circular SPK center chain detected -- body ${current} is its own ancestor`);
    }
    if (visited.size >= MAX_CHAIN_HOPS) {
      throw new Error(
        `spkez: center chain for body ${bodyId} did not reach the Solar System Barycenter (body 0) ` +
          `within ${MAX_CHAIN_HOPS} hops`
      );
    }
    visited.add(current);

    const segment = pickSegmentForBody(pool, current, et);
    if (!segment) {
      throw new Error(
        `spkez: no path back to the Solar System Barycenter (body 0) for body ${bodyId} at ET=${et} -- ` +
          `stuck at body ${current}, which has no loaded SPK segment covering this time. Loaded (target, ` +
          `center) pairs: ${spkSegments(pool)
            .map((s) => `(${s.target}, ${s.center})`)
            .join(', ') || 'none'}.`
      );
    }
    if (frame !== null && segment.frame !== frame) {
      throw new Error(
        `spkez: mixed reference frames along body ${bodyId}'s center chain (frame ${frame} vs ` +
          `${segment.frame} at body ${current}) -- frame transforms are not supported yet`
      );
    }
    frame = segment.frame;

    const state = evaluateSegment(segment, et);
    position = add(position, state.position);
    velocity = add(velocity, state.velocity);
    current = segment.center;
  }

  return { position, velocity, frame };
}

function assertCompatibleFrames(a, b, target, observer) {
  if (a !== null && b !== null && a !== b) {
    throw new Error(
      `spkez: target ${target}'s chain uses frame ${a} but observer ${observer}'s chain uses frame ${b} ` +
        '-- frame transforms are not supported yet, so target and observer must resolve through the same frame'
    );
  }
}

function relativeState(pool, target, observer, observerState, et) {
  const targetState = chainStateToSsb(pool, target, et);
  assertCompatibleFrames(targetState.frame, observerState.frame, target, observer);
  return {
    position: sub(targetState.position, observerState.position),
    velocity: sub(targetState.velocity, observerState.velocity),
    frame: targetState.frame ?? observerState.frame,
  };
}

/** The light-time iteration shared by spkez() and correctedPosition() below. */
function lightTimeCorrectedRelative(pool, target, observer, observerState, et, correction) {
  const ltSign = correction.xmit ? 1 : -1;
  let relative = relativeState(pool, target, observer, observerState, et);
  let lightTime = norm(relative.position) / CLIGHT_KM_S;
  for (let i = 0; i < correction.maxIter; i++) {
    relative = relativeState(pool, target, observer, observerState, et + ltSign * lightTime);
    lightTime = norm(relative.position) / CLIGHT_KM_S;
  }
  return { relative, lightTime };
}

/** Light-time- and (if requested) stellar-aberration-corrected position only, as a function of `et`. */
function correctedPosition(pool, target, observer, et, correction) {
  const observerState = chainStateToSsb(pool, observer, et);
  const { relative } = lightTimeCorrectedRelative(pool, target, observer, observerState, et, correction);
  if (!correction.stellar) return relative.position;
  const obsVelocity = correction.xmit ? scale(observerState.velocity, -1) : observerState.velocity;
  return stellarAberration(relative.position, obsVelocity);
}

/**
 * Like correctedPosition(), but additionally rotated into `frameId`
 * (see rotateState()) at the epoch appropriate for that frame under
 * `correction` (see nonInertialFrameEpoch()) -- i.e. the *whole*
 * aberration-corrected-and-rotated position, as a function of `et`.
 *
 * spkez() central-differences *this* (rather than differencing
 * correctedPosition() and applying a fixed-epoch rotation afterward)
 * to get velocity when `frameId` is non-inertial and light-time
 * correction is in play: real SPICE's non-inertial `ref` support
 * evaluates the frame's orientation at `et + ltsign*ltcent`, and
 * `ltcent` itself varies with `et` (it's a light time), so the
 * rotation is not simply a fixed matrix applied to an
 * already-differentiated velocity -- there's an extra chain-rule term
 * (NAIF's spkez.c scales the rotation derivative block by
 * `1 + ltsign*d(ltcent)/d(et)` to account for exactly this). Central-
 * differencing the fully-corrected-and-rotated position captures that
 * term automatically, the same way spkez() already avoids hand-
 * deriving `d(lightTime)/d(et)` for the target/observer correction
 * itself (see VELOCITY_DERIVATIVE_STEP_S below).
 */
function correctedPositionInFrame(pool, target, observer, et, correction, frameId) {
  const observerState = chainStateToSsb(pool, observer, et);
  const { relative, lightTime } = lightTimeCorrectedRelative(pool, target, observer, observerState, et, correction);
  let position = relative.position;
  if (correction.stellar) {
    const obsVelocity = correction.xmit ? scale(observerState.velocity, -1) : observerState.velocity;
    position = stellarAberration(position, obsVelocity);
  }
  const rotationEt = nonInertialFrameEpoch(pool, frameId, target, observer, et, observerState, correction, lightTime);
  return rotateState(relative.frame, frameId, position, [0, 0, 0], rotationEt, pool).position;
}

// Step size for the central-difference velocity of an aberration-
// corrected position (see spkez()). 1 second is tiny relative to how
// smoothly orbital positions vary (truncation error is negligible),
// while position magnitudes are typically ~1e8 km, so float64
// round-off in the difference is only ~1e-8 km -- ~1e-8 km/s of
// velocity error, far below anything a Chebyshev-fit ephemeris is
// accurate to in the first place.
const VELOCITY_DERIVATIVE_STEP_S = 1.0;

// Mirrors spkapp_'s exact correction table: iteration count and
// direction ("reception" vs "transmission"), and whether stellar
// aberration is applied.
const ABCORR = {
  NONE: { maxIter: 0, stellar: false, xmit: false },
  LT: { maxIter: 1, stellar: false, xmit: false },
  'LT+S': { maxIter: 1, stellar: true, xmit: false },
  CN: { maxIter: 3, stellar: false, xmit: false },
  'CN+S': { maxIter: 3, stellar: true, xmit: false },
  XLT: { maxIter: 1, stellar: false, xmit: true },
  'XLT+S': { maxIter: 1, stellar: true, xmit: true },
  XCN: { maxIter: 3, stellar: false, xmit: true },
  'XCN+S': { maxIter: 3, stellar: true, xmit: true },
};

/**
 * Reception-case stellar aberration (NAIF's stelab_): correct
 * `position` (the vector from observer to target) for the observer's
 * velocity `vobs` relative to the SSB. The transmission case is this
 * same correction applied to `-vobs` (NAIF's stlabx_).
 */
function stellarAberration(position, vobs) {
  if (norm(position) === 0) return position.slice(); // no direction to rotate a zero-length vector toward
  const vbyc = scale(vobs, 1 / CLIGHT_KM_S);
  if (vbyc[0] * vbyc[0] + vbyc[1] * vbyc[1] + vbyc[2] * vbyc[2] >= 1) {
    throw new Error('spkez: observer speed is >= the speed of light -- cannot apply stellar aberration');
  }
  const h = cross(unit(position), vbyc);
  const sinPhi = norm(h);
  if (sinPhi === 0) return position.slice();
  return rotateAboutAxis(position, h, Math.asin(sinPhi));
}

/**
 * The epoch at which a non-inertial `ref` frame's orientation should
 * be evaluated, per NAIF's documented rule (spkez.c): for `abcorr`
 * other than 'NONE', it's not simply `et` -- it's `et + ltsign*ltcent`,
 * where `ltcent` is the light time between the *frame's center body*
 * and the observer (0 if the frame is centered on the observer
 * itself, the already-computed target light time if centered on the
 * target, or a fresh light-time computation otherwise), and `ltsign`
 * matches the correction's reception/transmission direction. For
 * inertial frames (frameCenter() returns `null`) or `abcorr='NONE'`
 * (no light-time correction at all), this is just `et`.
 */
function nonInertialFrameEpoch(pool, frameId, target, observer, et, observerState, correction, targetLightTime) {
  if (correction.maxIter === 0 && !correction.stellar) return et; // 'NONE'
  const center = frameCenter(frameId, pool);
  if (center === null) return et; // inertial: time-independent, epoch doesn't matter

  let ltcent;
  if (center === observer) {
    ltcent = 0;
  } else if (center === target) {
    ltcent = targetLightTime;
  } else {
    ltcent = lightTimeCorrectedRelative(pool, center, observer, observerState, et, correction).lightTime;
  }
  const ltSign = correction.xmit ? 1 : -1;
  return et + ltSign * ltcent;
}

/**
 * `target`'s state relative to `observer` at `et`, following center
 * chains back to the Solar System Barycenter to connect bodies that
 * aren't directly related by one loaded segment (e.g. Earth relative
 * to the SSB, when the kernel only stores Earth relative to the
 * Earth-Moon barycenter and the EMB relative to the SSB) -- unlike
 * spkState(), which only looks up a single, direct segment. This is
 * SPICE's spkez_c: `target`/`observer` are NAIF integer IDs (not the
 * body name strings spkezr_c takes -- see spkezr() below for that).
 *
 * @param {number} target
 * @param {number} observer
 * @param {number} et - ephemeris time, TDB seconds past J2000
 * @param {string} [abcorr] - one of 'NONE' (default), 'LT', 'LT+S',
 *   'CN', 'CN+S', 'XLT', 'XLT+S', 'XCN', 'XCN+S' (case/whitespace
 *   insensitive) -- see NAIF's spkez_c documentation for what each
 *   means; briefly, LT/CN are light-time (one-iteration vs.
 *   converged) correction for the "reception" case, X-prefixed are
 *   the "transmission" case, and +S additionally applies stellar
 *   aberration.
 * @param {string} [ref] - name of a supported reference frame (one of
 *   the 21 built-in inertial frames, e.g. 'J2000', 'ECLIPJ2000',
 *   'B1950', 'GALACTIC'; a built-in body-fixed frame, e.g. 'IAU_MOON',
 *   'IAU_EARTH'; or a frame defined by a loaded frame kernel, e.g.
 *   'MOON_PA', 'MOON_ME' -- see frames.js) to express the result in.
 *   Omit (the default) to get the result in whatever frame the
 *   involved segments natively use, unrotated. If the segments along
 *   the way don't all natively agree on one frame, that's a clear
 *   error regardless of `ref` -- there's no rotation to reconcile them
 *   without knowing which one you want.
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {{ position: number[], velocity: number[], lightTime: number }}
 *
 * A note on velocity for corrected states: NAIF's documented formula
 * scales the target's velocity by `(1 +/- dLT/dET)` to account for
 * how the light-time correction itself changes with the observation
 * epoch, and further adjusts for the rate of change of the stellar
 * aberration rotation when `+S` is requested -- deriving and
 * hand-verifying both of those analytically is a real undertaking to
 * get exactly right. Since the documentation itself defines velocity
 * as "the derivative with respect to time of the position", spiceJS
 * computes it that way directly: a central difference of the fully
 * corrected *position* (light time, and stellar aberration if
 * requested) with respect to `et`, which captures every one of those
 * effects (including the observer's own motion) without re-deriving
 * them by hand. See VELOCITY_DERIVATIVE_STEP_S for why this is
 * accurate to far better than the underlying ephemeris data's own
 * precision. `NONE` needs no correction, so it skips this entirely
 * and uses the exact analytic velocity from the segment data.
 */
export function spkez(target, observer, et, abcorr = 'NONE', ref = null, pool = globalPool) {
  const key = String(abcorr).toUpperCase().replace(/\s+/g, '');
  const correction = ABCORR[key];
  if (!correction) {
    throw new Error(
      `spkez: unrecognized aberration correction "${abcorr}" (expected one of ${Object.keys(ABCORR).join(', ')})`
    );
  }

  const observerState = chainStateToSsb(pool, observer, et);
  const { relative, lightTime } = lightTimeCorrectedRelative(pool, target, observer, observerState, et, correction);

  let position = relative.position;
  let velocity = relative.velocity;

  if (correction.stellar) {
    const obsVelocity = correction.xmit ? scale(observerState.velocity, -1) : observerState.velocity;
    position = stellarAberration(position, obsVelocity);
  }

  if (correction.maxIter > 0 || correction.stellar) {
    const h = VELOCITY_DERIVATIVE_STEP_S;
    const plus = correctedPosition(pool, target, observer, et + h, correction);
    const minus = correctedPosition(pool, target, observer, et - h, correction);
    velocity = scale(sub(plus, minus), 1 / (2 * h));
  }

  if (ref !== null && relative.frame !== null) {
    const targetFrameId = resolveFrameId(ref, pool);
    const rotationEt = nonInertialFrameEpoch(
      pool,
      targetFrameId,
      target,
      observer,
      et,
      observerState,
      correction,
      lightTime
    );
    const rotated = rotateState(relative.frame, targetFrameId, position, velocity, rotationEt, pool);
    position = rotated.position;

    // frameCenter() === null means an inertial frame: rotationEt === et
    // always (see nonInertialFrameEpoch()) and the rotation is a fixed
    // matrix, so rotated.velocity (the exact analytic R*v) is already
    // correct -- same as it's always been. For a non-inertial frame
    // under light-time correction, rotationEt is itself a function of
    // et (through ltcent, a light time), which adds a chain-rule term
    // rotated.velocity doesn't capture (see correctedPositionInFrame()'s
    // doc comment) -- central-differencing the whole rotated position
    // captures it for free, just like the un-rotated case above.
    if ((correction.maxIter > 0 || correction.stellar) && frameCenter(targetFrameId, pool) !== null) {
      const h = VELOCITY_DERIVATIVE_STEP_S;
      const plus = correctedPositionInFrame(pool, target, observer, et + h, correction, targetFrameId);
      const minus = correctedPositionInFrame(pool, target, observer, et - h, correction, targetFrameId);
      velocity = scale(sub(plus, minus), 1 / (2 * h));
    } else {
      velocity = rotated.velocity;
    }
  }

  return { position, velocity, lightTime };
}

/**
 * SPICE's spkezr_c: like spkez(), but `target`/`observer` are body
 * *name* strings (e.g. `'MARS'`, `'EARTH BARYCENTER'`, or a plain
 * integer string) instead of NAIF integer IDs -- see bodies.js for
 * the name resolution rules (built-in NAIF names, or a loaded
 * NAIF_BODY_NAME/NAIF_BODY_CODE kernel pool override).
 *
 * @param {string} targetName
 * @param {string} observerName
 * @param {number} et
 * @param {string} [abcorr]
 * @param {string} [ref]
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {{ position: number[], velocity: number[], lightTime: number }}
 */
export function spkezr(targetName, observerName, et, abcorr = 'NONE', ref = null, pool = globalPool) {
  const target = bodyCode(targetName, pool);
  const observer = bodyCode(observerName, pool);
  return spkez(target, observer, et, abcorr, ref, pool);
}
