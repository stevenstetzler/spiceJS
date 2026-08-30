/**
 * CK: NAIF's binary spacecraft/instrument-orientation ("C-matrix")
 * kernel format, built on the generic DAF container (daf.js) -- the
 * same container SPK and PCK use, just with its own summary shape and
 * segment layouts. Ported from `ckr01.c`/`cke01.c` (type 1, discrete),
 * `ckr02.c`/`cke02.c` (type 2, fixed angular rate), `ckr03.c`/`cke03.c`
 * (type 3, linearly interpolated) and `ckgp_c.c`/`ckgp.c`/`ckmeta.c`
 * (the public search + frame-composition entry points) in the
 * OpenSpace/Spice mirror.
 *
 * A CK summary has ND=2, NI=6 (confirmed from `ckr01.c`'s own
 * descriptor-unpacking comment):
 *   dc = [startSclk, stopSclk]           (encoded SCLK, "ticks")
 *   ic = [inst, refFrame, type, avFlag, startAddr, endAddr]
 *
 * `inst` is the NAIF ID of the instrument/spacecraft/structure this
 * segment gives orientation for; `refFrame` is the (usually inertial)
 * frame the returned "C-matrix" rotates *from* -- see `ckgp()`'s own
 * frame-composition step for what happens when a caller asks for a
 * different frame.
 *
 * **On-disk directories skipped, same precedent as SPK's own unequal-
 * step segments** (see `docs/lazy-loading.md`'s Phase 4 note on
 * `interpolatedRecord.js`): every CK data type here stores a small
 * on-disk "directory" (a subsampled index into its own time array)
 * purely so a disk-based reader can binary-search *that* first instead
 * of the full array, before fetching. Since every CK segment this
 * module reads is already fully in memory (`segment.buffer`), that
 * optimization has no purpose here -- every search below binary-
 * searches the real, full time array directly, which is mathematically
 * identical to (never just an approximation of) walking the directory
 * first. The bytes the directory *occupies* are still accounted for
 * (skipped over, not misread as data), just never parsed.
 *
 * "C-matrix" (`cmat` throughout, matching CSPICE's own naming) rotates
 * a vector's components from the segment's `refFrame` (or, after
 * `ckgp()`'s composition, whatever frame the caller asked for) to
 * components in the instrument-fixed frame -- see `ckgp()`'s own doc
 * comment for the exact convention, byte-for-byte the same as
 * `ckgp_c`'s.
 */
import { parseDaf, readWords } from './daf.js';
import { globalPool } from './pool.js';
import { quaternionToMatrix, axisAngleToMatrix, matrixToAxisAngle } from './math/quaternion.js';
import { frameId, frameIsInertial, frameRotationMatrix } from './frames.js';
import { sclkToEt } from './sclk.js';

const CK_ND = 2;
const CK_NI = 6;
const SUPPORTED_TYPES = new Set([1, 2, 3]);

/** The pure `{dc, ic}` -> segment-descriptor field mapping CK's ND=2,NI=6 summary shape uses. */
export function summaryToCkSegment({ dc, ic }) {
  return {
    startSclk: dc[0],
    stopSclk: dc[1],
    inst: ic[0],
    refFrame: ic[1],
    type: ic[2],
    avFlag: ic[3],
    startAddr: ic[4],
    endAddr: ic[5],
  };
}

/**
 * Decode a binary CK file's segments from its raw bytes. Each returned
 * segment carries its own `buffer`/`littleEndian` so it can be
 * evaluated independently of the file it came from (mirrors
 * `pck.js`'s `loadPck()`/`spk.js`'s `loadSpk()`).
 */
export function loadCk(buffer) {
  const daf = parseDaf(buffer);
  if (!daf.idWord.startsWith('DAF/CK') && !daf.idWord.startsWith('NAIF/DAF')) {
    throw new Error(`ck: not a binary CK file (DAF ID word is "${daf.idWord}")`);
  }
  if (daf.nd !== CK_ND || daf.ni !== CK_NI) {
    throw new Error(`ck: unexpected summary shape ND=${daf.nd} NI=${daf.ni} (CK requires ND=2, NI=6)`);
  }
  return daf.summaries.map((summary) => ({
    ...summaryToCkSegment(summary),
    buffer,
    littleEndian: daf.littleEndian,
  }));
}

function words(segment, startAddr, endAddr) {
  return readWords(segment.buffer, segment.littleEndian, startAddr, endAddr);
}

/** Index (0-based) minimizing `|arr[i] - value|`, ties broken toward the *larger* index -- `LSTCLD`, used by type 1's nearest-instance search. `arr` must be ascending and non-empty. */
function nearestIndex(arr, value) {
  let lower = 0;
  let upper = arr.length - 1;
  while (lower < upper) {
    const mid = Math.ceil((lower + upper) / 2);
    if (arr[mid] <= value) lower = mid;
    else upper = mid - 1;
  }
  // `lower` is the last index with arr[lower] <= value (or 0 if none).
  if (lower === arr.length - 1) return lower;
  if (arr[lower] > value) return lower; // value is before the very first entry
  const after = lower + 1;
  return arr[after] - value <= value - arr[lower] ? after : lower;
}

/** Count of `arr` entries `<= value` (0..arr.length) -- `LSTLED`'s "last index at or below" recast as a count, since that's exactly the 1-based index this codebase's helpers already return. `arr` must be ascending. */
function countAtOrBelow(arr, value) {
  if (arr.length === 0 || value < arr[0]) return 0;
  let lower = 0;
  let upper = arr.length - 1;
  while (lower < upper) {
    const mid = Math.ceil((lower + upper) / 2);
    if (arr[mid] <= value) lower = mid;
    else upper = mid - 1;
  }
  return lower + 1;
}

function packetSize(avFlag) {
  return avFlag === 1 ? 7 : 4;
}

/** CK type 1 (discrete pointing instances): `ckr01_`+`cke01_`. */
function evaluateType1(segment, sclkdp, tol, needAv) {
  const psiz = packetSize(segment.avFlag);
  if (needAv && psiz !== 7) throw new Error('ck: segment does not contain angular velocity data');
  const { startAddr: beg, endAddr: end } = segment;
  const nrec = Math.round(words(segment, end, end)[0]);

  const times = words(segment, beg + psiz * nrec, beg + (psiz + 1) * nrec - 1);
  const idx = nearestIndex(times, sclkdp);
  if (Math.abs(sclkdp - times[idx]) > tol) return { found: false };

  const packetStart = beg + psiz * idx;
  const packet = words(segment, packetStart, packetStart + psiz - 1);
  const cmat = quaternionToMatrix([packet[0], packet[1], packet[2], packet[3]]);
  const av = needAv ? [packet[4], packet[5], packet[6]] : null;
  return { found: true, cmat, av, clkout: times[idx] };
}

/** CK type 2 (fixed angular rate over each interval): `ckr02_`+`cke02_`. */
function evaluateType2(segment, sclkdp, tol) {
  const { startAddr: beg, endAddr: end } = segment;
  const arrsiz = end - beg + 1;
  const nrec = Math.round((arrsiz * 100) / 1001); // see module doc: solves nrec*10 + floor((nrec-1)/100) ~= arrsiz
  const packetsAddr = beg;
  const startsAddr = beg + 8 * nrec;
  const stopsAddr = beg + 9 * nrec;

  const starts = words(segment, startsAddr, startsAddr + nrec - 1);
  const n = countAtOrBelow(starts, sclkdp);

  let start, clkout, index; // index: 0-based packet index
  if (n === 0) {
    if (sclkdp + tol < starts[0]) return { found: false };
    start = starts[0];
    clkout = starts[0];
    index = 0;
  } else {
    const i = n - 1; // 0-based index of the last start <= sclkdp
    const stopI = words(segment, stopsAddr + i, stopsAddr + i)[0];
    if (sclkdp <= stopI) {
      start = starts[i];
      clkout = sclkdp;
      index = i;
    } else if (n === nrec) {
      if (sclkdp - tol > stopI) return { found: false };
      start = starts[i];
      clkout = stopI;
      index = i;
    } else {
      const diff1 = sclkdp - stopI;
      const diff2 = starts[i + 1] - sclkdp;
      if (Math.min(diff1, diff2) > tol) return { found: false };
      if (diff2 <= diff1) {
        start = starts[i + 1];
        clkout = starts[i + 1];
        index = i + 1;
      } else {
        start = starts[i];
        clkout = stopI;
        index = i;
      }
    }
  }

  const packetStart = packetsAddr + 8 * index;
  const packet = words(segment, packetStart, packetStart + 7);
  const [q0, q1, q2, q3, av1, av2, av3, rate] = packet;
  const dt = (clkout - start) * rate;
  const angle = dt * Math.hypot(av1, av2, av3);
  const rot = axisAngleToMatrix([av1, av2, av3], angle);
  const cbase = quaternionToMatrix([q0, q1, q2, q3]);
  // cmat = cbase * rot^T (`mxmt_`), matching cke02_ exactly.
  const cmat = multiplyByTranspose(cbase, rot);
  return { found: true, cmat, av: [av1, av2, av3], clkout };
}

/** CK type 3 (linear interpolation between quaternion+AV instances, broken into separately-tracked continuous intervals): `ckr03_`+`cke03_`. */
function evaluateType3(segment, sclkdp, tol, needAv) {
  const psiz = packetSize(segment.avFlag);
  if (needAv && psiz !== 7) throw new Error('ck: segment does not contain angular velocity data');
  const { startAddr: beg, endAddr: end } = segment;
  const [numint, numrec] = words(segment, end - 1, end).map((v) => Math.round(v));
  const nrdir = Math.floor((numrec - 1) / 100);

  const recordTimesAddr = beg + psiz * numrec;
  const recordTimes = words(segment, recordTimesAddr, recordTimesAddr + numrec - 1);
  const intervalStartsAddr = beg + (psiz + 1) * numrec + nrdir;
  const intervalStarts = words(segment, intervalStartsAddr, intervalStartsAddr + numint - 1);

  // Before the very first record, or at/after the very last one: these
  // are real segment-boundary cases, resolved by tolerance alone --
  // `ckr03_` itself returns immediately here, before ever consulting
  // the interval-starts array at all (there's no "gap" reasoning left
  // to do: there's only one candidate record, take it or don't).
  const i = countAtOrBelow(recordTimes, sclkdp); // count of record times <= sclkdp
  if (i === 0) {
    if (recordTimes[0] - sclkdp > tol) return { found: false };
    const only = words(segment, beg, beg + psiz - 1);
    return { found: true, ...interpolateType3(only, only, recordTimes[0], recordTimes[0], sclkdp, needAv) };
  }
  if (i === numrec) {
    if (sclkdp - recordTimes[numrec - 1] > tol) return { found: false };
    const lastAddr = beg + psiz * (numrec - 1);
    const only = words(segment, lastAddr, lastAddr + psiz - 1);
    return { found: true, ...interpolateType3(only, only, recordTimes[numrec - 1], recordTimes[numrec - 1], sclkdp, needAv) };
  }
  const lsclk = recordTimes[i - 1];
  const rsclk = recordTimes[i];
  const laddr = beg + psiz * (i - 1);
  const raddr = beg + psiz * i;

  // `nstart`: the start of whichever interval comes *after* wherever
  // sclkdp/rsclk currently falls -- Infinity if there is none (rsclk is
  // in the last interval). Only `nstart` is actually used below (this
  // mirrors `ckr03_` itself, whose own analogous `start` variable is
  // computed but likewise only feeds a cross-call cache irrelevant to
  // a single evaluation's correctness -- not replicated here).
  const j = countAtOrBelow(intervalStarts, sclkdp);
  const nstart = j === numint ? Infinity : intervalStarts[j];

  const left = words(segment, laddr, laddr + psiz - 1);
  const right = words(segment, raddr, raddr + psiz - 1);

  if (rsclk < nstart) {
    return { found: true, ...interpolateType3(left, right, lsclk, rsclk, sclkdp, needAv) };
  }
  const ldiff = sclkdp - lsclk;
  const rdiff = rsclk - sclkdp;
  if (Math.min(ldiff, rdiff) > tol) return { found: false };
  const useLeft = ldiff < rdiff;
  const packet = useLeft ? left : right;
  const clkout = useLeft ? lsclk : rsclk;
  return { found: true, ...interpolateType3(packet, packet, clkout, clkout, sclkdp, needAv) };
}

function interpolateType3(left, right, t1, t2, t, needAv) {
  const q1 = [left[0], left[1], left[2], left[3]];
  const q2 = [right[0], right[1], right[2], right[3]];
  if (t1 === t2) {
    const cmat = quaternionToMatrix(q1);
    const av = needAv ? [left[4], left[5], left[6]] : null;
    return { cmat, av, clkout: t1 };
  }
  const frac = (t - t1) / (t2 - t1);
  const cmat1 = quaternionToMatrix(q1);
  const cmat2 = quaternionToMatrix(q2);
  // rot = cmat2^T * cmat1 (`mtxm_`), then decompose to axis/angle, take
  // `frac` of the angle, and re-apply from cmat1 -- matches cke03_ exactly.
  const rot = multiplyTransposeBy(cmat2, cmat1);
  const { axis, angle } = matrixToAxisAngle(rot);
  const delta = axisAngleToMatrix(axis, angle * frac);
  const cmat = multiplyByTranspose(cmat1, delta);
  let av = null;
  if (needAv) {
    const av1 = [left[4], left[5], left[6]];
    const av2 = [right[4], right[5], right[6]];
    av = [
      (1 - frac) * av1[0] + frac * av2[0],
      (1 - frac) * av1[1] + frac * av2[1],
      (1 - frac) * av1[2] + frac * av2[2],
    ];
  }
  return { cmat, av, clkout: t };
}

/** `a * b` (`mxm_`). */
function multiply(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

/** `m^T * v` (`mtxv_`). */
function multiplyTransposeByVector(m, v) {
  return [m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]];
}

/** `a * b^T` (`mxmt_`). */
function multiplyByTranspose(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[j][0] + a[i][1] * b[j][1] + a[i][2] * b[j][2];
    }
  }
  return out;
}

/** `a^T * b` (`mtxm_`). */
function multiplyTransposeBy(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[0][i] * b[0][j] + a[1][i] * b[1][j] + a[2][i] * b[2][j];
    }
  }
  return out;
}

/**
 * Evaluate one CK segment at `sclkdp` (encoded SCLK, "ticks"), within
 * tolerance `tol` (same units). Returns `{ found: false }` if no
 * pointing instance satisfies the request, or `{ found: true, cmat,
 * av, clkout }` -- `cmat` rotates a vector's components from
 * `segment.refFrame` to the instrument-fixed frame at time `clkout`
 * (the actual encoded SCLK the returned pointing corresponds to, which
 * can differ from `sclkdp` by up to `tol`); `av` is the angular
 * velocity vector (relative to `segment.refFrame`), or `null` if
 * `needAv` was false.
 *
 * @param {object} segment - from `loadCk()`
 * @param {number} sclkdp
 * @param {number} tol
 * @param {boolean} [needAv]
 * @returns {{ found: boolean, cmat?: number[][], av?: number[]|null, clkout?: number }}
 */
export function evaluateSegment(segment, sclkdp, tol, needAv = false) {
  if (!SUPPORTED_TYPES.has(segment.type)) {
    throw new Error(`ck: segment data type ${segment.type} is not supported yet (only types 1, 2, 3 are)`);
  }
  if (segment.type === 1) return evaluateType1(segment, sclkdp, tol, needAv);
  if (segment.type === 2) return evaluateType2(segment, sclkdp, tol);
  return evaluateType3(segment, sclkdp, tol, needAv);
}

/**
 * Find pointing for `inst` at `sclkdp` across every loaded CK segment
 * for that instrument, mirroring `ckgp_`'s own segment-priority search
 * (`ckbss_`/`cksns_`/`ckpfs_`): the *last-loaded* file has priority,
 * and within a file, the *last* matching segment does -- exactly
 * `pool.getCkSegments()`'s own load-order array, walked in reverse.
 * Unlike `pck.js`'s `findPckSegment()` (a single filter-and-take-last),
 * this has to actually try evaluating each candidate and fall through
 * on a miss: a segment whose *declared* coverage overlaps `sclkdp` can
 * still have no record within `tol` of it (a gap), in which case the
 * next-priority segment gets a chance too -- `ckgp_c`'s own
 * "Tolerance and segment priority" cases 2 and 4 document exactly
 * this.
 *
 * @param {import('./pool.js').KernelPool} pool
 * @param {number} inst
 * @param {number} sclkdp
 * @param {number} tol
 * @param {boolean} [needAv]
 * @returns {{ found: boolean, cmat?: number[][], av?: number[]|null, clkout?: number, segment?: object }}
 */
export function findCkPointing(pool, inst, sclkdp, tol, needAv = false) {
  const segments = pool.getCkSegments(inst);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (sclkdp + tol < segment.startSclk || sclkdp - tol > segment.stopSclk) continue;
    const result = evaluateSegment(segment, sclkdp, tol, needAv);
    if (result.found) return { ...result, segment };
  }
  return { found: false };
}

/**
 * The SCLK ID associated with instrument/structure `inst` -- pool
 * variable `CK_<inst>_SCLK`, falling back to `floor(inst/1000)` when
 * unset (only for `inst <= -1000`, an instrument-shaped ID) --
 * `ckmeta_`'s own documented convention (e.g. Cassini's ISS camera,
 * -82000, falls back to spacecraft clock -82 with no kernel variable
 * needed at all).
 */
function sclkIdForInstrument(inst, pool) {
  const values = pool.getValues(`CK_${inst}_SCLK`);
  if (values) return Number(values[0]);
  if (inst <= -1000) return Math.floor(inst / 1000);
  throw new Error(
    `ck: don't know which spacecraft clock instrument ${inst} uses -- no CK_${inst}_SCLK pool variable is set, ` +
      `and ${inst} isn't a conventional (<= -1000) instrument ID to fall back from`
  );
}

/**
 * Get pointing (orientation) for `inst` at `sclkdp` (encoded SCLK,
 * "ticks" -- see `sclk.js`'s `scEncode()`/`etToSclk()`), within
 * tolerance `tol` (same units, e.g. from `sclk.js`'s own
 * `scTicksForFields()` applied to a duration string) -- SPICE's
 * `ckgp_c`.
 *
 * `cmat` rotates a vector's components from `ref` to components in the
 * instrument-fixed frame at the returned `clkout`:
 *
 *   [x', y', z']^T = cmat * [x, y, z]^T
 *
 * where `[x,y,z]` are a vector's components in `ref` and `[x',y',z']`
 * are the same vector's components in the instrument frame -- use
 * `cmat`'s transpose to go the other way. If the found segment's own
 * `refFrame` differs from `ref`, this composes with the rotation
 * matrix between them (`frames.js`'s `frameRotationMatrix()`) -- which
 * needs an ephemeris time only when at least one of the two frames
 * isn't inertial (a fixed rotation between two non-rotating frames has
 * no time dependence at all), obtained via `sclk.js`'s `sclkToEt()`
 * using `inst`'s own spacecraft clock (`sclkIdForInstrument()` above).
 *
 * @param {number} inst - NAIF ID of the instrument/spacecraft/structure
 * @param {number} sclkdp
 * @param {number} tol
 * @param {string} ref - target reference frame name
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {{ found: boolean, cmat?: number[][], clkout?: number }}
 */
export function ckgp(inst, sclkdp, tol, ref, pool = globalPool) {
  const { found, cmat, clkout, segment } = findCkPointing(pool, inst, sclkdp, tol, false);
  if (!found) return { found: false };

  const refId = frameId(ref, pool);
  if (refId === segment.refFrame) return { found: true, cmat, clkout };

  const et = frameIsInertial(refId) && frameIsInertial(segment.refFrame) ? undefined : sclkToEt(sclkIdForInstrument(inst, pool), clkout, pool);
  const { matrix: rot } = frameRotationMatrix(refId, segment.refFrame, et, pool);
  // cmat_new = cmat * rot (`mxm_`), matching ckgp_ exactly.
  return { found: true, cmat: multiply(cmat, rot), clkout };
}

/**
 * Like `ckgp()`, but also returns the angular velocity vector (`av`,
 * relative to `ref`, radians/second) -- SPICE's `ckgpav_c`. When the
 * segment's own `refFrame` differs from `ref`, `av` composes with
 * *two* terms (`ckgpav_`'s own `xf2rav_`+`mxm_`/`mtxv_`/`vadd_` steps):
 * the segment's own av vector, re-expressed in `ref` by the same
 * rotation `cmat` uses (`rot^T * av`, since `av` lives in `segment.refFrame`
 * and the composition needs the opposite direction from `cmat`'s own
 * `ref -> segment.refFrame` rotation) -- **plus** `omega`, the angular
 * velocity of `segment.refFrame` *relative to* `ref` itself. That
 * second term only matters when `ref`/`segment.refFrame` are rotating
 * relative to each other (e.g. one of them is a body-fixed frame) --
 * for two frames with no relative rotation (the common case: both
 * inertial, or one inertial and a TK fixed-offset frame off the other)
 * `omega` is exactly zero and this reduces to the plain vector rotation
 * alone. `omega`'s extraction from the rotation matrix's own time
 * derivative (`dmatrix`) is `xf2rav_`'s specific antisymmetric-matrix
 * convention, re-derived here rather than guessed at, since a sign
 * error in either term would be a silent-wrong-answer bug -- verified
 * against spiceypy's own `ckgpav_c` in crossval for exactly that reason.
 *
 * @param {number} inst
 * @param {number} sclkdp
 * @param {number} tol
 * @param {string} ref
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {{ found: boolean, cmat?: number[][], av?: number[], clkout?: number }}
 */
export function ckgpav(inst, sclkdp, tol, ref, pool = globalPool) {
  const { found, cmat, av, clkout, segment } = findCkPointing(pool, inst, sclkdp, tol, true);
  if (!found) return { found: false };

  const refId = frameId(ref, pool);
  if (refId === segment.refFrame) return { found: true, cmat, av, clkout };

  const et = frameIsInertial(refId) && frameIsInertial(segment.refFrame) ? undefined : sclkToEt(sclkIdForInstrument(inst, pool), clkout, pool);
  const { matrix: rot, dmatrix } = frameRotationMatrix(refId, segment.refFrame, et, pool);
  const combinedCmat = multiply(cmat, rot);

  // omega = the antisymmetric part of dmatrix^T * rot, read off exactly
  // the way xf2rav_ does: omega = [M[2][1], M[0][2], M[1][0]].
  const m = multiplyTransposeBy(dmatrix, rot);
  const omega = [m[2][1], m[0][2], m[1][0]];
  const rotatedAv = multiplyTransposeByVector(rot, av);
  const combinedAv = [omega[0] + rotatedAv[0], omega[1] + rotatedAv[1], omega[2] + rotatedAv[2]];

  return { found: true, cmat: combinedCmat, av: combinedAv, clkout };
}

/**
 * List every currently-loaded binary CK segment's descriptor
 * (instrument, frame, type, tick coverage) -- mirrors `pck.js`'s
 * `pckSegments()`.
 *
 * @param {import('./pool.js').KernelPool} [pool]
 */
export function ckSegments(pool = globalPool) {
  return pool.allCkSegments().map(({ inst, refFrame, type, avFlag, startSclk, stopSclk }) => ({
    inst,
    refFrame,
    type,
    avFlag,
    startSclk,
    stopSclk,
  }));
}
