/**
 * The DAF segment layouts shared by SPK types 8/12 (equal time step),
 * 9/13 (unequal time step), and 5 (two-body propagation, also
 * unequal time step) -- confirmed against NAIF's own writers
 * (spkw05/08/09/12/13.c) and, for window selection, spkr08.c (which
 * literally handles *both* types 8 and 12 -- `spkr12_` just calls
 * `spkr08_` directly) and spkr09.c (likewise shared by 9 and 13 via
 * `spkr13_` calling `spkr09_`; type 5's own spkr05.c uses the same
 * epoch/directory layout as 9/13, just always with a 2-state window).
 * Only the *evaluator* differs within each layout family -- see
 * math/lagrangeHermite.js (8/9/12/13) and src/prop2b.js (5).
 *
 * Equal-step (8/12): `[state_0..state_{N-1} (6 each), begin, step,
 * degreeOrWindowSizeMinus1, N]`.
 *
 * Unequal-step (5/9/13): `[state_0..state_{N-1} (6 each), epoch_0..
 * epoch_{N-1}, directory epochs (one per 100 states, purely a lookup-
 * speed optimization -- skipped here; see readUnequalStepEpochs's
 * doc comment), trailerField, N]` (`trailerField` is a degree/window-
 * size-minus-1 for 9/13, or GM for 5).
 *
 * The 9/13 epilog field is named "degree" for the Lagrange type and
 * "window size - 1" for the Hermite one, but arithmetically it's the
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

function readStates(segment, first, windowSize) {
  const statesStart = segment.startAddr + first * 6;
  const raw = readWords(segment.buffer, segment.littleEndian, statesStart, statesStart + windowSize * 6 - 1);
  return toStates(raw, windowSize);
}

/** NAIF's window-centering rule (spkr08.c, shared verbatim by types 8 and 12). */
function windowStart(nearIdx0, degree, n) {
  return Math.min(Math.max(nearIdx0 - Math.floor(degree / 2), 0), n - 1 - degree);
}

/** The `[begin, step, degreeOrWindowSizeMinus1, N]` epilog of an equal-time-step segment (SPK types 8/12). */
export function readEqualStepEpilog(segment) {
  const [begin, step, degreeField, nField] = readWords(
    segment.buffer,
    segment.littleEndian,
    segment.endAddr - 3,
    segment.endAddr
  );
  const windowSize = Math.round(degreeField) + 1;
  return { begin, step, windowSize, degree: windowSize - 1, n: Math.round(nField) };
}

/**
 * The starting state index of the window `selectEqualStepWindow()`
 * would pick for a single `et` -- factored out so it can be reused
 * for a whole *range* below (`equalStepIndexRangeForQuery()`) without
 * duplicating NAIF's odd/even window-anchoring rule.
 */
function equalStepWindowStartAt(begin, step, degree, n, et) {
  const windowSize = degree + 1;
  const nearIdx0 = windowSize % 2 === 1 ? Math.round((et - begin) / step) : Math.floor((et - begin) / step);
  return windowStart(nearIdx0, degree, n);
}

/**
 * The `[firstIndex, lastIndexExclusive)` union of every window
 * `selectEqualStepWindow()` would touch for *any* `et` in
 * `[etStart, etEnd]` (a single state's window when `etStart ===
 * etEnd`) -- used by `lazy/byteRange.js` to prefetch exactly the
 * states a query range needs. Correct because
 * `equalStepWindowStartAt()` is monotonic non-decreasing in `et`
 * (`nearIdx0` is a monotonic function of `et`, and clamping preserves
 * that): the union's start is where `etStart`'s own window starts,
 * and its end is where `etEnd`'s own window ends.
 */
export function equalStepIndexRangeForQuery(segment, etStart, etEnd) {
  const { begin, step, windowSize, degree, n } = readEqualStepEpilog(segment);
  const firstIndex = equalStepWindowStartAt(begin, step, degree, n, etStart);
  const lastIndexExclusive = equalStepWindowStartAt(begin, step, degree, n, etEnd) + windowSize;
  return { firstIndex, lastIndexExclusive };
}

/**
 * Reads just the 2-word `[trailerField, N]` epilog of an unequal-
 * time-step segment (types 5/9/13) -- deliberately *not* the epoch
 * array itself, so `lazy/byteRange.js` can learn `N` (and, from it,
 * exactly where the epoch array lives) as its own fetch step, before
 * the epoch array's bytes are necessarily populated. Skips past the
 * on-disk "directory" (a lookup-speed optimization for very large
 * segments -- binary-searching it to avoid scanning all N epochs) the
 * same way `readUnequalStepEpochs()` below does.
 */
export function readUnequalStepTrailer(segment) {
  const [trailerField, nField] = readWords(segment.buffer, segment.littleEndian, segment.endAddr - 1, segment.endAddr);
  const n = Math.round(nField);
  const directoryCount = Math.floor((n - 1) / 100);
  const epochsEnd = segment.endAddr - 2 - directoryCount;
  const epochsStart = epochsEnd - n + 1;
  return { trailerField, n, epochsStart, epochsEnd };
}

/**
 * Reads the `[trailerField, N]` epilog and the `N`-entry `epochs`
 * array of an unequal-time-step segment (types 5/9/13). This reads
 * `epochs` directly instead of via the on-disk directory -- correct
 * for any N, just not the fastest possible for huge ones. spiceJS's
 * own segment *writer* (test/helpers/writeSpk.js) keeps synthetic
 * segments at N <= 100 specifically so it never has to write that
 * directory at all.
 */
function readUnequalStepEpochs(segment) {
  const { trailerField, n, epochsStart, epochsEnd } = readUnequalStepTrailer(segment);
  const epochs = Array.from(readWords(segment.buffer, segment.littleEndian, epochsStart, epochsEnd));
  return { trailerField, n, epochs };
}

/** Index of the last epoch <= et (0 if et is at or before epochs[0]). */
function lastEpochAtOrBefore(epochs, et) {
  let idx = 0;
  for (let i = 0; i < epochs.length; i++) {
    if (epochs[i] <= et) idx = i;
    else break;
  }
  return idx;
}

/**
 * The `field + 1` consecutive states (and their epochs) nearest `et`,
 * for an equal-time-step segment (SPK types 8/12).
 *
 * @returns {{ epochs: number[], states: number[][] }} each `states[i]`
 *   is `[x, y, z, vx, vy, vz]`, `epochs[i]` its epoch (TDB seconds past J2000)
 */
export function selectEqualStepWindow(segment, et) {
  const { begin, step, windowSize, degree, n } = readEqualStepEpilog(segment);
  // Odd window size: the state nearest ET anchors the (roughly) centered
  // window. Even: the state at-or-before ET does (NAIF's spkr08.c).
  const first = equalStepWindowStartAt(begin, step, degree, n, et);

  const epochs = [];
  for (let i = 0; i < windowSize; i++) epochs.push(begin + (first + i) * step);

  return { epochs, states: readStates(segment, first, windowSize) };
}

/**
 * The starting state index of the window `selectUnequalStepWindow()`
 * would pick for a single `et`, given an already-read `epochs` array
 * -- factored out so it can be reused for a whole *range* below
 * (`unequalStepIndexRangeForQuery()`) without duplicating NAIF's odd/
 * even window-anchoring rule (the same rule `equalStepWindowStartAt()`
 * implements for the equal-step types, just anchored off the nearest
 * *epoch value* instead of an arithmetic step index).
 */
function unequalStepWindowStartAt(epochs, n, windowSize, degree, et) {
  const idx = lastEpochAtOrBefore(epochs, et);
  let nearIdx0;
  if (windowSize % 2 === 1) {
    // Odd: whichever of the bracketing pair (idx, idx+1) is numerically closer to et.
    nearIdx0 = idx + 1 >= n || Math.abs(et - epochs[idx]) <= Math.abs(et - epochs[idx + 1]) ? idx : idx + 1;
  } else {
    nearIdx0 = idx; // even: the bracketing pair itself anchors the window
  }
  return windowStart(nearIdx0, degree, n);
}

/**
 * The `field + 1` consecutive states (and their epochs) nearest `et`,
 * for an unequal-time-step segment (SPK types 9/13). See
 * readUnequalStepEpochs()'s doc comment for the on-disk "directory"
 * this skips past.
 */
export function selectUnequalStepWindow(segment, et) {
  const { trailerField, n, epochs } = readUnequalStepEpochs(segment);
  const windowSize = Math.round(trailerField) + 1;
  const degree = windowSize - 1;
  const first = unequalStepWindowStartAt(epochs, n, windowSize, degree, et);

  return { epochs: epochs.slice(first, first + windowSize), states: readStates(segment, first, windowSize) };
}

/**
 * The `[firstIndex, lastIndexExclusive)` union of every window
 * `selectUnequalStepWindow()` would touch for *any* `et` in
 * `[etStart, etEnd]` -- the types 9/13 counterpart to
 * `equalStepIndexRangeForQuery()`. Unlike that one, this needs the
 * segment's epoch *array* already populated (window/bracket selection
 * here is data-dependent, not arithmetic) -- `lazy/byteRange.js`
 * fetches the trailer (`readUnequalStepTrailer()`) and then the epoch
 * array itself before calling this.
 */
export function unequalStepIndexRangeForQuery(segment, etStart, etEnd) {
  const { trailerField, n, epochs } = readUnequalStepEpochs(segment);
  const windowSize = Math.round(trailerField) + 1;
  const degree = windowSize - 1;
  const firstIndex = unequalStepWindowStartAt(epochs, n, windowSize, degree, etStart);
  const lastIndexExclusive = unequalStepWindowStartAt(epochs, n, windowSize, degree, etEnd) + windowSize;
  return { firstIndex, lastIndexExclusive };
}

/** The `[firstIndex, secondIndex]` bracketing pair selectBracketingPair() would pick for a single `et`. */
function bracketingPairAt(epochs, n, et) {
  if (et <= epochs[0]) return [0, 0];
  if (et >= epochs[n - 1]) return [n - 1, n - 1];
  const first = lastEpochAtOrBefore(epochs, et); // 0 <= first < n-1 here
  return [first, first + 1];
}

/**
 * The pair of states bracketing `et` (and the segment's central-body
 * `gm`), for a two-body-propagation segment (SPK type 5) -- always
 * exactly 2 states, clamped to a repeated single epoch/state if `et`
 * is at or beyond either end of the segment's own coverage (confirmed
 * in spke05.c's Detailed_Input: "If ET is less than the first time in
 * the segment then both epochs 1 and 2 are equal to the first time",
 * symmetrically at the end).
 *
 * @returns {{ gm: number, epochs: [number, number], states: [number[], number[]] }}
 */
export function selectBracketingPair(segment, et) {
  const { trailerField: gm, n, epochs } = readUnequalStepEpochs(segment);
  const [first, second] = bracketingPairAt(epochs, n, et);

  return {
    gm,
    epochs: [epochs[first], epochs[second]],
    states: [readStates(segment, first, 1)[0], readStates(segment, second, 1)[0]],
  };
}

/**
 * The `[firstIndex, lastIndexExclusive)` union of every bracketing
 * pair `selectBracketingPair()` would touch for *any* `et` in
 * `[etStart, etEnd]` -- the type 5 counterpart to
 * `unequalStepIndexRangeForQuery()`. Same epoch-array-must-already-be-
 * populated caveat.
 */
export function bracketingIndexRangeForQuery(segment, etStart, etEnd) {
  const { n, epochs } = readUnequalStepEpochs(segment);
  const [firstIndex] = bracketingPairAt(epochs, n, etStart);
  const [, secondIndexAtEnd] = bracketingPairAt(epochs, n, etEnd);
  return { firstIndex, lastIndexExclusive: secondIndexAtEnd + 1 };
}
