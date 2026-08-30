/**
 * Given a segment descriptor (target/center/frame/type/startAddr/
 * endAddr -- from a lazily-fetched file's structural metadata, before
 * its *data* has been fetched) and a query window, figures out --
 * and, along the way, `ensureRange()`s -- exactly the bytes that
 * segment's evaluation will touch for any `et` in
 * `[etStart, etEnd]`. See `docs/lazy-loading.md` for the byte-range
 * math per segment type and why it's dispatched here rather than
 * handled by any change to `spk.js`/`chebyshevRecord.js` themselves.
 *
 * Async, uniformly, even though types 2/3/8/12's own math needs no
 * further fetch beyond the segment's own epilog: types 5/9/13/21 need
 * a genuinely data-dependent, multi-step fetch (the epoch array has to
 * be read before the touched window/bracket/record is even known --
 * see `unequalStepByteRange()`/`type21ByteRange()` below), so this
 * function's shape has to accommodate that from the start. Type
 * 5/9/13/21 support here is the "small-N" case from
 * `docs/lazy-loading.md`'s Phase 3 -- large-N kernels of these types
 * need the on-disk epoch directory (`interpolatedRecord.js` doesn't
 * implement it, and neither does this), scoped separately as that
 * document's Phase 4.
 */
import { readEpilog } from '../math/chebyshevRecord.js';
import {
  equalStepIndexRangeForQuery,
  readUnequalStepTrailer,
  unequalStepIndexRangeForQuery,
  bracketingIndexRangeForQuery,
  differenceLineIndexRangeForQuery,
} from '../math/interpolatedRecord.js';

const STATE_WORDS = 6; // [x, y, z, vx, vy, vz]

function clampRecno(recno, recordCount) {
  return Math.min(Math.max(recno, 0), recordCount - 1);
}

/** [startByte, endByteExclusive) of a segment's own epilog/trailer -- its last `wordCount` words. */
function trailerByteRange(segment, wordCount) {
  const wordStart = segment.endAddr - wordCount + 1;
  return { startByte: (wordStart - 1) * 8, endByteExclusive: segment.endAddr * 8 };
}

/**
 * Types 2/3 (Chebyshev, spke02.c/spke03.c): fixed-size, fixed-interval
 * records -- `recno = floor((et - INIT) / INTLEN)` is pure arithmetic
 * once the segment's own 4-word epilog (INIT/INTLEN/RSIZE/N) is known.
 */
async function chebyshevByteRange(remoteFile, segment, etStart, etEnd) {
  const epilogRange = trailerByteRange(segment, 4);
  await remoteFile.ensureRange(epilogRange.startByte, epilogRange.endByteExclusive);

  const { init, intlen, recordSize, recordCount } = readEpilog(segment);
  const recnoStart = clampRecno(Math.floor((etStart - init) / intlen), recordCount);
  const recnoEnd = clampRecno(Math.floor((etEnd - init) / intlen), recordCount);
  const wordStart = segment.startAddr + recnoStart * recordSize;
  const wordEndExclusive = segment.startAddr + (recnoEnd + 1) * recordSize;
  return { startByte: (wordStart - 1) * 8, endByteExclusive: (wordEndExclusive - 1) * 8 };
}

/**
 * Types 8/12 (Lagrange/Hermite, equal step, spkr08.c/spkr12.c): a
 * fixed-size window of states, arithmetic from the segment's own
 * `begin`/`step`/`degree`/`N` epilog -- same complexity class as
 * types 2/3, just windowed states instead of Chebyshev records. The
 * touched-index-range math itself lives in `interpolatedRecord.js`
 * (`equalStepIndexRangeForQuery()`), reused from the real,
 * single-point `selectEqualStepWindow()` reader so the two can't
 * silently drift apart.
 */
async function equalStepByteRange(remoteFile, segment, etStart, etEnd) {
  const epilogRange = trailerByteRange(segment, 4);
  await remoteFile.ensureRange(epilogRange.startByte, epilogRange.endByteExclusive);

  const { firstIndex, lastIndexExclusive } = equalStepIndexRangeForQuery(segment, etStart, etEnd);
  const wordStart = segment.startAddr + firstIndex * STATE_WORDS;
  const wordEndExclusive = segment.startAddr + lastIndexExclusive * STATE_WORDS;
  return { startByte: (wordStart - 1) * 8, endByteExclusive: (wordEndExclusive - 1) * 8 };
}

/**
 * Types 5/9/13 (two-body propagation / Lagrange / Hermite, unequal
 * step, spkr05.c/spkr09.c/spkr13.c): unlike every type above, window/
 * bracket selection here is *data-dependent* -- epochs aren't evenly
 * spaced, so the touched state range can't be computed from a formula
 * alone. Two fetches instead of one: the segment's own 2-word trailer
 * (`readUnequalStepTrailer()`) to learn `N` and where the epoch array
 * lives, then the epoch array itself -- only *then* can
 * `interpolatedRecord.js`'s existing (unmodified) epoch-reading logic
 * run to figure out which states are actually needed. This is the
 * "small-N" case from `docs/lazy-loading.md`: for a kernel with a huge
 * `N`, fetching the *whole* epoch array stops being cheap, and the
 * on-disk directory (skipped here, same as `interpolatedRecord.js`
 * itself skips it) would need to be implemented to scale further --
 * out of scope here, see that document's Phase 4.
 */
async function unequalStepByteRange(remoteFile, segment, etStart, etEnd) {
  const trailerRange = trailerByteRange(segment, 2);
  await remoteFile.ensureRange(trailerRange.startByte, trailerRange.endByteExclusive);

  const { epochsStart, epochsEnd } = readUnequalStepTrailer(segment);
  const epochByteRange = { startByte: (epochsStart - 1) * 8, endByteExclusive: epochsEnd * 8 };
  await remoteFile.ensureRange(epochByteRange.startByte, epochByteRange.endByteExclusive);

  const { firstIndex, lastIndexExclusive } =
    segment.type === 5
      ? bracketingIndexRangeForQuery(segment, etStart, etEnd)
      : unequalStepIndexRangeForQuery(segment, etStart, etEnd);
  const wordStart = segment.startAddr + firstIndex * STATE_WORDS;
  const wordEndExclusive = segment.startAddr + lastIndexExclusive * STATE_WORDS;
  return { startByte: (wordStart - 1) * 8, endByteExclusive: (wordEndExclusive - 1) * 8 };
}

/**
 * Type 21 (extended difference lines, spkr21.c): same two-fetch shape
 * as `unequalStepByteRange()` above (the trailer/epoch/directory
 * layout is byte-for-byte the same family -- see
 * `interpolatedRecord.js`'s own doc comment), but each record is
 * `4*maxdim+11` words instead of a fixed 6-word state (`maxdim` is
 * exactly the trailer's own `trailerField`, read in the first fetch),
 * and exactly *one* record is touched per `et` rather than a window
 * or bracketing pair -- `differenceLineIndexRangeForQuery()` is the
 * type 21 counterpart to `bracketingIndexRangeForQuery()`.
 */
async function type21ByteRange(remoteFile, segment, etStart, etEnd) {
  const trailerRange = trailerByteRange(segment, 2);
  await remoteFile.ensureRange(trailerRange.startByte, trailerRange.endByteExclusive);

  const { trailerField: maxdim, epochsStart, epochsEnd } = readUnequalStepTrailer(segment);
  const epochByteRange = { startByte: (epochsStart - 1) * 8, endByteExclusive: epochsEnd * 8 };
  await remoteFile.ensureRange(epochByteRange.startByte, epochByteRange.endByteExclusive);

  const { firstIndex, lastIndexExclusive } = differenceLineIndexRangeForQuery(segment, etStart, etEnd);
  const dlsiz = 4 * maxdim + 11;
  const wordStart = segment.startAddr + firstIndex * dlsiz;
  const wordEndExclusive = segment.startAddr + lastIndexExclusive * dlsiz;
  return { startByte: (wordStart - 1) * 8, endByteExclusive: (wordEndExclusive - 1) * 8 };
}

const BYTE_RANGE_BY_TYPE = {
  2: chebyshevByteRange,
  3: chebyshevByteRange,
  5: unequalStepByteRange,
  8: equalStepByteRange,
  9: unequalStepByteRange,
  12: equalStepByteRange,
  13: unequalStepByteRange,
  21: type21ByteRange,
};

/**
 * @param {import('./remoteFile.js').RemoteFile} remoteFile
 * @param {object} segment - `{ type, startAddr, endAddr, buffer, littleEndian }`
 * @param {number} etStart
 * @param {number} etEnd
 * @returns {Promise<{ startByte: number, endByteExclusive: number }>} the segment's own data byte range for this query
 */
export async function byteRangeForQuery(remoteFile, segment, etStart, etEnd) {
  const handler = BYTE_RANGE_BY_TYPE[segment.type];
  if (!handler) {
    throw new Error(
      `lazy: segment type ${segment.type} is not supported for lazy loading yet (supported so far: 2, 3, 5, 8, 9, 12, 13, 21)`
    );
  }
  return handler(remoteFile, segment, etStart, etEnd);
}
