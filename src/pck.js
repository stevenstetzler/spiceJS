/**
 * PCK: NAIF's binary body-orientation kernel format, built on the
 * generic DAF container (daf.js) -- confirmed to parse unmodified
 * against a real binary PCK file (`ND=2, NI=5`).
 *
 * A PCK summary has ND=2, NI=5:
 *   dc = [startEt, stopEt]                (TDB seconds past J2000)
 *   ic = [frame, refFrame, type, startAddr, endAddr]
 *
 * `frame` is the NAIF frame ID this segment gives orientation data
 * for (e.g. 31008 for MOON_PA_DE440); `refFrame` is the frame the
 * Euler angles are expressed relative to (in every real kernel this
 * project has seen, J2000 = 1 -- see frames.js for how a different
 * value would be handled).
 *
 * Only segment type 2 (Chebyshev polynomials for 3 Euler angles) is
 * supported -- confirmed against NAIF's pcke02.c, which calls
 * spke02_() directly: PCK type 2 is byte-for-byte the same record
 * layout as SPK type 2 (see math/chebyshevRecord.js, shared by both),
 * just interpreted as `[phi, delta, w]` instead of `[x, y, z]`.
 */
import { parseDaf } from './daf.js';
import { evaluateWithDerivative } from './math/chebyshev.js';
import { selectRecord } from './math/chebyshevRecord.js';
import { globalPool } from './pool.js';

const PCK_ND = 2;
const PCK_NI = 5;
const SUPPORTED_TYPES = new Set([2]);

/**
 * Decode a binary PCK file's segments from its raw bytes. Each
 * returned segment carries its own `buffer`/`littleEndian` so it can
 * be evaluated independently of the file it came from.
 */
export function loadPck(buffer) {
  const daf = parseDaf(buffer);
  // "NAIF/DAF" is a generic, older ID word real CSPICE still accepts
  // as PCK data -- see kernels.js's furnsh() for the shape-based
  // (ND=2,NI=5) disambiguation from SPK/CK.
  if (!daf.idWord.startsWith('DAF/PCK') && !daf.idWord.startsWith('NAIF/DAF')) {
    throw new Error(`pck: not a binary PCK file (DAF ID word is "${daf.idWord}")`);
  }
  if (daf.nd !== PCK_ND || daf.ni !== PCK_NI) {
    throw new Error(`pck: unexpected summary shape ND=${daf.nd} NI=${daf.ni} (PCK requires ND=2, NI=5)`);
  }

  return daf.summaries.map(({ dc, ic }) => ({
    startEt: dc[0],
    stopEt: dc[1],
    frame: ic[0],
    refFrame: ic[1],
    type: ic[2],
    startAddr: ic[3],
    endAddr: ic[4],
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

  const eulerAngles = [];
  const eulerRates = [];
  for (let axis = 0; axis < 3; axis++) {
    const start = 2 + axis * ncoef;
    const coeffs = record.subarray(start, start + ncoef);
    const { value, derivative } = evaluateWithDerivative(coeffs, s);
    eulerAngles.push(value);
    eulerRates.push(derivative / radius);
  }
  return { eulerAngles, eulerRates };
}

/**
 * Evaluate a segment at `et` (TDB seconds past J2000), returning
 * `{ eulerAngles: [phi, delta, w], eulerRates: [dphi, ddelta, dw] }`
 * (radians, radians/second) relative to `segment.refFrame` -- no
 * frame transform is applied.
 */
export function evaluateSegment(segment, et) {
  if (!SUPPORTED_TYPES.has(segment.type)) {
    throw new Error(`pck: segment data type ${segment.type} is not supported yet (only type 2 -- Chebyshev -- is)`);
  }
  return evaluateType2(segment, et);
}

/**
 * The loaded PCK segment giving `frameId`'s orientation at `et`, or
 * `null` if none is loaded (the caller falls back to the classic
 * text-PCK formula -- see frames.js -- matching NAIF's documented
 * "binary PCK first, text P_constants as fallback" priority). Among
 * multiple covering segments, prefers the *last-loaded* one, matching
 * SPICE's own "most recently furnsh'd kernel has priority" convention.
 */
export function findPckSegment(pool, frameId, et) {
  const candidates = pool
    .getPckSegments(frameId)
    .filter((segment) => et >= segment.startEt && et <= segment.stopEt);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * List every currently-loaded binary PCK segment's descriptor (frame,
 * refFrame, type, and ET coverage).
 *
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function pckSegments(pool = globalPool) {
  return pool.allPckSegments().map(({ frame, refFrame, type, startEt, stopEt }) => ({
    frame,
    refFrame,
    type,
    startEt,
    stopEt,
  }));
}
