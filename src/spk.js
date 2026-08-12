/**
 * SPK: NAIF's binary trajectory (ephemeris) kernel format, built on
 * the generic DAF container (daf.js).
 *
 * An SPK summary has ND=2, NI=6:
 *   dc = [startEt, stopEt]                       (TDB seconds past J2000)
 *   ic = [target, center, frame, type, startAddr, endAddr]
 * `startAddr`/`endAddr` bound the segment's raw data as DAF addresses.
 *
 * Only segment types 2 and 3 (Chebyshev polynomials) are supported --
 * these cover the vast majority of publicly distributed planetary,
 * lunar, and satellite kernels. Both share the same logical-record
 * layout (confirmed against NAIF's spkr02.c/spke02.c and
 * spkr03.c/spke03.c):
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
 */
import { parseDaf, readWords } from './daf.js';
import { evaluate, evaluateWithDerivative } from './math/chebyshev.js';
import { add, sub, scale, cross, norm, unit, rotateAboutAxis } from './math/vector3.js';
import { globalPool } from './pool.js';

const SPK_ND = 2;
const SPK_NI = 6;
const SUPPORTED_TYPES = new Set([2, 3]);

const CLIGHT_KM_S = 299792.458; // exact, by SI definition of the meter
const MAX_CHAIN_HOPS = 20; // matches NAIF's own CHLEN (spkgeo.f)
const SSB = 0;

/**
 * Decode an SPK file's segments from its raw bytes. Each returned
 * segment carries its own `buffer`/`littleEndian` so it can be
 * evaluated independently of the file it came from.
 */
export function loadSpk(buffer) {
  const daf = parseDaf(buffer);
  if (!daf.idWord.startsWith('DAF/SPK')) {
    throw new Error(`spk: not an SPK file (DAF ID word is "${daf.idWord}")`);
  }
  if (daf.nd !== SPK_ND || daf.ni !== SPK_NI) {
    throw new Error(`spk: unexpected summary shape ND=${daf.nd} NI=${daf.ni} (SPK requires ND=2, NI=6)`);
  }

  return daf.summaries.map(({ dc, ic }) => ({
    startEt: dc[0],
    stopEt: dc[1],
    target: ic[0],
    center: ic[1],
    frame: ic[2],
    type: ic[3],
    startAddr: ic[4],
    endAddr: ic[5],
    buffer,
    littleEndian: daf.littleEndian,
  }));
}

function readEpilog(segment) {
  const [init, intlen, recordSize, recordCount] = readWords(
    segment.buffer,
    segment.littleEndian,
    segment.endAddr - 3,
    segment.endAddr
  );
  return { init, intlen, recordSize: Math.round(recordSize), recordCount: Math.round(recordCount) };
}

function selectRecord(segment, et) {
  const { init, intlen, recordSize, recordCount } = readEpilog(segment);
  let recno = Math.floor((et - init) / intlen);
  recno = Math.min(Math.max(recno, 0), recordCount - 1);
  const recordStart = segment.startAddr + recno * recordSize;
  return readWords(segment.buffer, segment.littleEndian, recordStart, recordStart + recordSize - 1);
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

/**
 * Evaluate a segment at `et` (TDB seconds past J2000), returning
 * `{ position: [x,y,z], velocity: [vx,vy,vz] }` in km and km/s, in
 * the segment's native reference frame (see `segment.frame`) -- no
 * frame transform is applied.
 */
export function evaluateSegment(segment, et) {
  if (!SUPPORTED_TYPES.has(segment.type)) {
    throw new Error(
      `spk: segment data type ${segment.type} is not supported yet (only types 2 and 3 -- Chebyshev ` +
        'position and position+velocity -- are implemented)'
    );
  }
  return segment.type === 2 ? evaluateType2(segment, et) : evaluateType3(segment, et);
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
 * `target`'s state relative to `observer` at `et`, following center
 * chains back to the Solar System Barycenter to connect bodies that
 * aren't directly related by one loaded segment (e.g. Earth relative
 * to the SSB, when the kernel only stores Earth relative to the
 * Earth-Moon barycenter and the EMB relative to the SSB) -- unlike
 * spkState(), which only looks up a single, direct segment. This is
 * SPICE's spkez_c: `target`/`observer` are NAIF integer IDs (not the
 * body name strings spkezr_c takes), and the result is in whatever
 * frame the involved segments natively use (not the arbitrary frame
 * spkez_c/spkezr_c let you request -- frame rotation isn't
 * implemented yet, so mismatched frames along the way are a clear
 * error rather than a wrong answer).
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
export function spkez(target, observer, et, abcorr = 'NONE', pool = globalPool) {
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

  return { position, velocity, lightTime };
}
