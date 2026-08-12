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
import { globalPool } from './pool.js';

const SPK_ND = 2;
const SPK_NI = 6;
const SUPPORTED_TYPES = new Set([2, 3]);

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
