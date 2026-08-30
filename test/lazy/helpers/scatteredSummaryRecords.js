import { FILE_RECORD_BYTES } from '../../../src/daf.js';

const WORD_BYTES = 8;

/**
 * Rewrites a `writeSpk()` buffer so its summary-record chain is
 * *scattered*: record 2 keeps every segment summary but now points
 * (via its NEXT word) at a second, empty summary record placed
 * `gapRecords` records further into the file, with everything in
 * between left as filler. Real DAFs get this layout naturally --
 * summary records are appended as the file grows, so they end up
 * interleaved with the array data they describe -- but `writeSpk()`
 * only ever emits the single-record case, so a chain that spans a
 * large gap has to be constructed here.
 *
 * This is the shape that caught `prefetchQuery()` bulk-fetching the
 * whole FWARD..BWARD *span* instead of the records themselves (see
 * that function's `ensureSummaryRecords()`): the parsed result is
 * identical either way, so only the number of bytes fetched
 * distinguishes them -- which is exactly what the regression test
 * asserts.
 *
 * @param {Uint8Array} buf - a whole SPK file from writeSpk()
 * @param {number} gapRecords - how many 1024-byte records to leave between the two summary records
 * @returns {{ buf: Uint8Array, spanBytes: number, secondRecordNumber: number }}
 */
export function scatterSummaryRecords(buf, gapRecords = 400) {
  const out = new Uint8Array(buf.byteLength + (gapRecords + 1) * FILE_RECORD_BYTES);
  out.set(buf, 0);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // writeSpk() always puts its one summary record at record 2 and is
  // little-endian; both are asserted here rather than assumed, so this
  // helper fails loudly if that ever changes rather than silently
  // producing a file that tests nothing.
  const fward = dv.getInt32(76, true);
  const bward = dv.getInt32(80, true);
  if (fward !== 2 || bward !== 2) {
    throw new Error(`scatterSummaryRecords: expected writeSpk()'s single summary record at 2, got FWARD=${fward} BWARD=${bward}`);
  }

  const secondRecordNumber = Math.floor(buf.byteLength / FILE_RECORD_BYTES) + gapRecords + 1;
  const secondOffset = (secondRecordNumber - 1) * FILE_RECORD_BYTES;

  // Record 2's NEXT (its first word) now points at the far record.
  dv.setFloat64(FILE_RECORD_BYTES, secondRecordNumber, true);

  // The far record: NEXT=0 (chain ends), PREV=2, NSUM=0 (no summaries
  // of its own -- this test is about *reaching* it, not what it holds).
  dv.setFloat64(secondOffset, 0, true);
  dv.setFloat64(secondOffset + WORD_BYTES, 2, true);
  dv.setFloat64(secondOffset + 2 * WORD_BYTES, 0, true);

  dv.setInt32(80, secondRecordNumber, true); // BWARD now names the far record

  return {
    buf: out,
    spanBytes: secondOffset + FILE_RECORD_BYTES - FILE_RECORD_BYTES, // FWARD..BWARD span, the old bulk-fetch size
    secondRecordNumber,
  };
}
