/**
 * The DAF Chebyshev "segment of fixed-size records" layout shared by
 * SPK types 2/3 and PCK type 2 (confirmed against NAIF's
 * spkr02.c/spkr03.c and pcke02.c, which literally calls spke02_ --
 * PCK type 2 is byte-identical to SPK type 2, just 3 Euler angles
 * instead of x/y/z):
 *
 *   segment = [record_0, record_1, ..., record_{N-1}, INIT, INTLEN, RSIZE, N]
 *   record  = [MID, RADIUS, coeffs...]
 *
 * `INIT`/`INTLEN`/`RSIZE`/`N` (the "epilog") are the last 4 doubles of
 * the segment and describe how to pick the right fixed-size record
 * for a given ET: `recno = floor((et - INIT) / INTLEN)`, clamped to
 * [0, N-1].
 */
import { readWords } from '../daf.js';

/** `segment` must have `{ buffer, littleEndian, startAddr, endAddr }` (DAF word addresses, 1-based). */
export function readEpilog(segment) {
  const [init, intlen, recordSize, recordCount] = readWords(
    segment.buffer,
    segment.littleEndian,
    segment.endAddr - 3,
    segment.endAddr
  );
  return { init, intlen, recordSize: Math.round(recordSize), recordCount: Math.round(recordCount) };
}

/** The fixed-size record covering `et`, as a Float64Array `[MID, RADIUS, coeffs...]`. */
export function selectRecord(segment, et) {
  const { init, intlen, recordSize, recordCount } = readEpilog(segment);
  let recno = Math.floor((et - init) / intlen);
  recno = Math.min(Math.max(recno, 0), recordCount - 1);
  const recordStart = segment.startAddr + recno * recordSize;
  return readWords(segment.buffer, segment.littleEndian, recordStart, recordStart + recordSize - 1);
}
