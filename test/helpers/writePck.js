/**
 * Test-only encoder for the DAF/PCK binary format, used to build
 * synthetic .bpc fixtures so pck.js/daf.js/frames.js can be
 * round-trip tested without a real (multi-megabyte) kernel file. Only
 * supports what's needed for that: a single summary record (up to 25
 * segments) of type 2 data, both endiannesses.
 *
 * This mirrors test/helpers/writeSpk.js almost exactly -- the only
 * differences are the DAF ID word, `ND=2, NI=5` (a body-fixed
 * orientation kernel's summary has one fewer integer than SPK's, and
 * so packs into the same 5-word/40-byte summary size only because
 * NI=5 rounds up to 3 double-words same as SPK's NI=6 does -- see
 * daf.js's `summarySize = nd + Math.ceil(ni / 2)`), and each record's
 * 3 Chebyshev coefficient sets are Euler angles (phi, delta, w)
 * instead of position (x, y, z).
 */
import { Buffer } from 'node:buffer';

const FILE_RECORD_BYTES = 1024;
const FIRST_DATA_ADDR = 385; // same layout as writeSpk.js: file record, summary record, name record
const MAX_SEGMENTS_PER_RECORD = 25;

/**
 * @param {object} opts
 * @param {boolean} [opts.littleEndian]
 * @param {Array<object>} opts.segments - each: { frame, refFrame, type,
 *   startEt, stopEt, init, intlen, records: [{ mid, radius,
 *   coeffsByAxis: number[][] }] } -- coeffsByAxis has 3 entries (phi,
 *   delta, w), all the same length (type 2 only).
 * @returns {Buffer}
 */
export function writePck({ littleEndian = true, segments }) {
  if (segments.length > MAX_SEGMENTS_PER_RECORD) {
    throw new Error(`writePck (test helper): only up to ${MAX_SEGMENTS_PER_RECORD} segments are supported`);
  }

  const writeDouble = (buf, offset, value) =>
    littleEndian ? buf.writeDoubleLE(value, offset) : buf.writeDoubleBE(value, offset);
  const writeInt32 = (buf, offset, value) =>
    littleEndian ? buf.writeInt32LE(value, offset) : buf.writeInt32BE(value, offset);

  let addr = FIRST_DATA_ADDR;
  const laidOut = segments.map((seg) => {
    const ncoef = seg.records[0].coeffsByAxis[0].length;
    const recordSize = 2 + 3 * ncoef;
    const startAddr = addr;
    addr += seg.records.length * recordSize + 4; // +4 for the [INIT, INTLEN, RSIZE, N] epilog
    return { ...seg, recordSize, startAddr, endAddr: addr - 1 };
  });

  const totalWords = addr - 1;
  const totalRecords = Math.ceil(totalWords / 128);
  const buf = Buffer.alloc(totalRecords * FILE_RECORD_BYTES);

  // --- File record ---
  buf.write('DAF/PCK ', 0, 'latin1');
  writeInt32(buf, 8, 2); // ND
  writeInt32(buf, 12, 5); // NI
  buf.write('spiceJS synthetic test PCK'.padEnd(60, ' '), 16, 'latin1');
  writeInt32(buf, 76, 2); // FWARD
  writeInt32(buf, 80, 2); // BWARD
  writeInt32(buf, 84, totalWords + 1); // FREE (not used by the reader)
  buf.write(littleEndian ? 'LTL-IEEE' : 'BIG-IEEE', 88, 'latin1');

  // --- Summary record (record 2) ---
  const sumRecOffset = FILE_RECORD_BYTES;
  writeDouble(buf, sumRecOffset, 0); // NEXT
  writeDouble(buf, sumRecOffset + 8, 0); // PREV
  writeDouble(buf, sumRecOffset + 16, laidOut.length); // NSUM
  let sumOffset = sumRecOffset + 24;
  for (const seg of laidOut) {
    writeDouble(buf, sumOffset, seg.startEt);
    writeDouble(buf, sumOffset + 8, seg.stopEt);
    writeInt32(buf, sumOffset + 16, seg.frame);
    writeInt32(buf, sumOffset + 20, seg.refFrame);
    writeInt32(buf, sumOffset + 24, seg.type);
    writeInt32(buf, sumOffset + 28, seg.startAddr);
    writeInt32(buf, sumOffset + 32, seg.endAddr);
    // sumOffset + 36..39: unused padding half-word (NI=5 is odd).
    sumOffset += 40; // 5 words (ND=2 + ceil(NI/2)=3) * 8 bytes
  }

  // --- Name record (record 3): blank, but must exist ---
  buf.write(' '.repeat(FILE_RECORD_BYTES), FILE_RECORD_BYTES * 2, 'latin1');

  // --- Segment data ---
  for (const seg of laidOut) {
    let wordAddr = seg.startAddr;
    for (const record of seg.records) {
      let byteOffset = (wordAddr - 1) * 8;
      writeDouble(buf, byteOffset, record.mid);
      byteOffset += 8;
      writeDouble(buf, byteOffset, record.radius);
      byteOffset += 8;
      for (const axisCoeffs of record.coeffsByAxis) {
        for (const c of axisCoeffs) {
          writeDouble(buf, byteOffset, c);
          byteOffset += 8;
        }
      }
      wordAddr += seg.recordSize;
    }
    let byteOffset = (wordAddr - 1) * 8;
    writeDouble(buf, byteOffset, seg.init);
    writeDouble(buf, byteOffset + 8, seg.intlen);
    writeDouble(buf, byteOffset + 16, seg.recordSize);
    writeDouble(buf, byteOffset + 24, seg.records.length);
  }

  return buf;
}
