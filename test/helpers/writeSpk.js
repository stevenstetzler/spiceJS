/**
 * Test-only encoder for the DAF/SPK binary format, used to build
 * synthetic .bsp fixtures so spk.js/daf.js can be round-trip tested
 * without a real (multi-megabyte, network-fetched) kernel file. Only
 * supports what's needed for that: a single summary record (up to 25
 * segments) of type 2/3 data, both endiannesses.
 *
 * This is the mirror image of src/daf.js + src/spk.js's decoding, so
 * it necessarily encodes the *same* understanding of the format --
 * see src/daf.js's doc comment for the byte layout this follows.
 */
import { Buffer } from 'node:buffer';

const FILE_RECORD_BYTES = 1024;
const FIRST_DATA_ADDR = 257; // after the file record (addrs 1-128) and one summary record (129-256)
const MAX_SEGMENTS_PER_RECORD = 25; // (128 - 3) / 5, for SPK's ND=2,NI=6 -> 5 words/summary

/**
 * @param {object} opts
 * @param {boolean} [opts.littleEndian]
 * @param {Array<object>} opts.segments - each: { target, center, frame,
 *   type, startEt, stopEt, init, intlen, records: [{ mid, radius,
 *   coeffsByAxis: number[][] }] } -- coeffsByAxis has 3 entries for
 *   type 2 (X,Y,Z) or 6 for type 3 (X,Y,Z,VX,VY,VZ), all the same length.
 * @returns {Buffer}
 */
export function writeSpk({ littleEndian = true, segments }) {
  if (segments.length > MAX_SEGMENTS_PER_RECORD) {
    throw new Error(`writeSpk (test helper): only up to ${MAX_SEGMENTS_PER_RECORD} segments are supported`);
  }

  const writeDouble = (buf, offset, value) =>
    littleEndian ? buf.writeDoubleLE(value, offset) : buf.writeDoubleBE(value, offset);
  const writeInt32 = (buf, offset, value) =>
    littleEndian ? buf.writeInt32LE(value, offset) : buf.writeInt32BE(value, offset);

  // First pass: lay out each segment's records + epilog and assign addresses.
  let addr = FIRST_DATA_ADDR;
  const laidOut = segments.map((seg) => {
    const axesPerRecord = seg.type === 2 ? 3 : 6;
    const ncoef = seg.records[0].coeffsByAxis[0].length;
    const recordSize = 2 + axesPerRecord * ncoef;
    const startAddr = addr;
    addr += seg.records.length * recordSize + 4; // +4 for the [INIT, INTLEN, RSIZE, N] epilog
    return { ...seg, recordSize, startAddr, endAddr: addr - 1 };
  });

  const totalWords = addr - 1;
  const buf = Buffer.alloc(totalWords * 8);

  // --- File record ---
  buf.write('DAF/SPK ', 0, 'latin1');
  writeInt32(buf, 8, 2); // ND
  writeInt32(buf, 12, 6); // NI
  buf.write('spiceJS synthetic test SPK'.padEnd(60, ' '), 16, 'latin1');
  writeInt32(buf, 76, 2); // FWARD: the one summary record is record 2
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
    writeInt32(buf, sumOffset + 16, seg.target);
    writeInt32(buf, sumOffset + 20, seg.center);
    writeInt32(buf, sumOffset + 24, seg.frame);
    writeInt32(buf, sumOffset + 28, seg.type);
    writeInt32(buf, sumOffset + 32, seg.startAddr);
    writeInt32(buf, sumOffset + 36, seg.endAddr);
    sumOffset += 40; // 5 words (ND=2 + NI/2=3) * 8 bytes
  }

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
