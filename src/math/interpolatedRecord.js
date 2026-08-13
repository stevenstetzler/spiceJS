/**
 * The two DAF segment layouts shared by SPK types 8/12 (equal time
 * step) and 9/13 (unequal time step) -- confirmed against NAIF's own
 * writers (spkw08.c/spkw09.c/spkw12.c/spkw13.c) and, for window
 * selection, spkr08.c (which literally handles *both* types 8 and 12
 * -- `spkr12_` just calls `spkr08_` directly) and spkr09.c (likewise
 * shared by 9 and 13 via `spkr13_` calling `spkr09_`). Only the
 * *evaluator* differs between the Lagrange (8/9) and Hermite (12/13)
 * pair -- see math/lagrangeHermite.js -- window selection is
 * identical for both members of each pair.
 *
 * Equal-step (8/12): `[state_0..state_{N-1} (6 each), begin, step,
 * degreeOrWindowSizeMinus1, N]`.
 *
 * Unequal-step (9/13): `[state_0..state_{N-1} (6 each), epoch_0..
 * epoch_{N-1}, directory epochs (one per 100 states, purely a lookup-
 * speed optimization -- skipped here; see selectUnequalStepWindow's
 * doc comment), degreeOrWindowSizeMinus1, N]`.
 *
 * Both epilog fields are named "degree" for the Lagrange types and
 * "window size - 1" for the Hermite ones, but arithmetically it's the
 * same value either way: the window used for interpolation always has
 * `field + 1` states (NAIF's own GRPSIZ/WNDSIZ).
 */
import { readWords } from '../daf.js';

function toStates(raw, windowSize) {
  const states = [];
  for (let i = 0; i < windowSize; i++) {
    states.push(Array.from(raw.subarray(i * 6, i * 6 + 6)));
  }
  return states;
}

/** NAIF's window-centering rule (spkr08.c, shared verbatim by types 8 and 12). */
function windowStart(nearIdx0, degree, n) {
  return Math.min(Math.max(nearIdx0 - Math.floor(degree / 2), 0), n - 1 - degree);
}

/**
 * The `field + 1` consecutive states (and their epochs) nearest `et`,
 * for an equal-time-step segment (SPK types 8/12).
 *
 * @returns {{ epochs: number[], states: number[][] }} each `states[i]`
 *   is `[x, y, z, vx, vy, vz]`, `epochs[i]` its epoch (TDB seconds past J2000)
 */
export function selectEqualStepWindow(segment, et) {
  const [begin, step, degreeField, nField] = readWords(
    segment.buffer,
    segment.littleEndian,
    segment.endAddr - 3,
    segment.endAddr
  );
  const n = Math.round(nField);
  const windowSize = Math.round(degreeField) + 1;
  const degree = windowSize - 1;

  // Odd window size: the state nearest ET anchors the (roughly) centered
  // window. Even: the state at-or-before ET does (NAIF's spkr08.c).
  const nearIdx0 = windowSize % 2 === 1 ? Math.round((et - begin) / step) : Math.floor((et - begin) / step);
  const first = windowStart(nearIdx0, degree, n);

  const epochs = [];
  for (let i = 0; i < windowSize; i++) epochs.push(begin + (first + i) * step);

  const statesStart = segment.startAddr + first * 6;
  const raw = readWords(segment.buffer, segment.littleEndian, statesStart, statesStart + windowSize * 6 - 1);
  return { epochs, states: toStates(raw, windowSize) };
}

/**
 * The `field + 1` consecutive states (and their epochs) nearest `et`,
 * for an unequal-time-step segment (SPK types 9/13).
 *
 * The on-disk format includes a "directory" of every 100th epoch, a
 * lookup-speed optimization for very large segments (binary-search the
 * directory to avoid scanning all N epochs). This reader ignores it
 * and scans the full `epochs` array directly instead -- correct for
 * any N, just not the fastest possible for very large ones. spiceJS's
 * own segment *writer* (test/helpers/writeSpk.js) keeps synthetic
 * type 9/13 segments at N <= 100 specifically so it never has to write
 * that directory at all (there's nothing to skip).
 */
export function selectUnequalStepWindow(segment, et) {
  const [degreeField, nField] = readWords(segment.buffer, segment.littleEndian, segment.endAddr - 1, segment.endAddr);
  const n = Math.round(nField);
  const windowSize = Math.round(degreeField) + 1;
  const degree = windowSize - 1;
  const directoryCount = Math.floor((n - 1) / 100);
  const epochsEnd = segment.endAddr - 2 - directoryCount;
  const epochsStart = epochsEnd - n + 1;
  const epochs = Array.from(readWords(segment.buffer, segment.littleEndian, epochsStart, epochsEnd));

  // Index of the last epoch <= et (0 if et is at or before epochs[0]).
  let idx = 0;
  for (let i = 0; i < n; i++) {
    if (epochs[i] <= et) idx = i;
    else break;
  }
  let nearIdx0;
  if (windowSize % 2 === 1) {
    // Odd: whichever of the bracketing pair (idx, idx+1) is numerically closer to et.
    nearIdx0 = idx + 1 >= n || Math.abs(et - epochs[idx]) <= Math.abs(et - epochs[idx + 1]) ? idx : idx + 1;
  } else {
    nearIdx0 = idx; // even: the bracketing pair itself anchors the window
  }
  const first = windowStart(nearIdx0, degree, n);

  const statesStart = segment.startAddr + first * 6;
  const raw = readWords(segment.buffer, segment.littleEndian, statesStart, statesStart + windowSize * 6 - 1);
  return { epochs: epochs.slice(first, first + windowSize), states: toStates(raw, windowSize) };
}
