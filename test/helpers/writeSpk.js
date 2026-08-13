/**
 * Test-only encoder for the DAF/SPK binary format, used to build
 * synthetic .bsp fixtures so spk.js/daf.js can be round-trip tested
 * without a real (multi-megabyte, network-fetched) kernel file. Only
 * supports what's needed for that: a single summary record (up to 25
 * segments) of type 2/3/5/8/9/12/13 data, both endiannesses.
 *
 * This is the mirror image of src/daf.js + src/spk.js's decoding, so
 * it necessarily encodes the *same* understanding of the format --
 * see src/daf.js's doc comment for the byte layout this follows, and
 * src/math/interpolatedRecord.js's doc comment for types 5/8/9/12/13's
 * layout specifically. Types 5/9/13 (unequal time step) segments are
 * capped at 100 states here so the on-disk "directory" (a lookup-speed
 * optimization for segments with more states than that) never needs
 * writing -- spiceJS's own reader ignores the directory regardless,
 * but a real CSPICE-compatible file needs it present for N > 100.
 */
import { Buffer } from 'node:buffer';

const FILE_RECORD_BYTES = 1024;
// After the file record (addrs 1-128), one summary record (129-256), and
// its paired name record (257-384). Real DAF files store array names in a
// character record immediately following each summary record; spiceJS's
// own reader never reads it (segments are looked up by ID, not name), but
// real CSPICE reads it even for a plain segment search (confirmed against
// spiceypy: omitting it entirely -- there's no record 3 at all -- fails
// with SPICE(DAFCRNOTFOUND) reading record 3), so it has to be present,
// even blank, for a file to be valid to other SPICE implementations.
const FIRST_DATA_ADDR = 385;
const MAX_SEGMENTS_PER_RECORD = 25; // (128 - 3) / 5, for SPK's ND=2,NI=6 -> 5 words/summary

/**
 * @param {object} opts
 * @param {boolean} [opts.littleEndian]
 * @param {Array<object>} opts.segments - each: { target, center, frame,
 *   type, startEt, stopEt, ... }, shaped per `type`:
 *   - 2/3 (Chebyshev): `init, intlen, records: [{ mid, radius,
 *     coeffsByAxis: number[][] }]` -- coeffsByAxis has 3 entries for
 *     type 2 (X,Y,Z) or 6 for type 3 (X,Y,Z,VX,VY,VZ), all the same length.
 *   - 8/12 (Lagrange/Hermite, equal time step): `begin, step, degree,
 *     states: number[][]` -- each state `[x,y,z,vx,vy,vz]`, `degree`
 *     is the interpolation degree (8) or window-size-minus-1 (12);
 *     the two are numerically interchangeable at the writer level.
 *   - 9/13 (Lagrange/Hermite, unequal time step): `degree,
 *     states: number[][], epochs: number[]` (same length as `states`,
 *     <= 100 entries -- see the module doc comment).
 *   - 5 (two-body propagation): `gm, states: number[][],
 *     epochs: number[]` (same length as `states`, <= 100 entries --
 *     see the module doc comment) -- identical on-disk shape to 9/13,
 *     just `gm` in the trailer slot instead of `degree`.
 * @returns {Buffer}
 */
export function writeSpk({ littleEndian = true, segments }) {
  if (segments.length > MAX_SEGMENTS_PER_RECORD) {
    throw new Error(`writeSpk (test helper): only up to ${MAX_SEGMENTS_PER_RECORD} segments are supported`);
  }
  for (const seg of segments) {
    if ((seg.type === 5 || seg.type === 9 || seg.type === 13) && seg.states.length > 100) {
      throw new Error('writeSpk (test helper): type 5/9/13 segments are capped at 100 states (no directory support)');
    }
  }

  const writeDouble = (buf, offset, value) =>
    littleEndian ? buf.writeDoubleLE(value, offset) : buf.writeDoubleBE(value, offset);
  const writeInt32 = (buf, offset, value) =>
    littleEndian ? buf.writeInt32LE(value, offset) : buf.writeInt32BE(value, offset);

  // First pass: lay out each segment's data + epilog and assign addresses.
  let addr = FIRST_DATA_ADDR;
  const laidOut = segments.map((seg) => {
    if (seg.type === 2 || seg.type === 3) {
      const axesPerRecord = seg.type === 2 ? 3 : 6;
      const ncoef = seg.records[0].coeffsByAxis[0].length;
      const recordSize = 2 + axesPerRecord * ncoef;
      const startAddr = addr;
      addr += seg.records.length * recordSize + 4; // +4 for the [INIT, INTLEN, RSIZE, N] epilog
      return { ...seg, recordSize, startAddr, endAddr: addr - 1 };
    }
    if (seg.type === 8 || seg.type === 12) {
      const startAddr = addr;
      addr += seg.states.length * 6 + 4; // states + [begin, step, degree, N]
      return { ...seg, startAddr, endAddr: addr - 1 };
    }
    if (seg.type === 5 || seg.type === 9 || seg.type === 13) {
      const startAddr = addr;
      addr += seg.states.length * 6 + seg.states.length + 2; // states + epochs + [degree|gm, N] (no directory)
      return { ...seg, startAddr, endAddr: addr - 1 };
    }
    throw new Error(`writeSpk (test helper): unsupported segment type ${seg.type}`);
  });

  const totalWords = addr - 1;
  // DAF files are Fortran direct-access files under the hood: every
  // record, including the last, must be a full 1024 bytes. Confirmed
  // against spiceypy/real CSPICE -- a file whose last record was left
  // short (as this writer used to produce) fails deep in SPKR02/DAFGDA
  // with a nonsensical "beginning address > ending address" error, since
  // CSPICE's own record-based I/O doesn't handle a partial final record.
  const totalRecords = Math.ceil(totalWords / 128);
  const buf = Buffer.alloc(totalRecords * FILE_RECORD_BYTES);

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

  // --- Name record (record 3): blank, but must exist ---
  buf.write(' '.repeat(FILE_RECORD_BYTES), FILE_RECORD_BYTES * 2, 'latin1');

  // --- Segment data ---
  for (const seg of laidOut) {
    if (seg.type === 2 || seg.type === 3) {
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
    } else if (seg.type === 8 || seg.type === 12) {
      let byteOffset = (seg.startAddr - 1) * 8;
      for (const state of seg.states) {
        for (const c of state) {
          writeDouble(buf, byteOffset, c);
          byteOffset += 8;
        }
      }
      writeDouble(buf, byteOffset, seg.begin);
      writeDouble(buf, byteOffset + 8, seg.step);
      writeDouble(buf, byteOffset + 16, seg.degree);
      writeDouble(buf, byteOffset + 24, seg.states.length);
    } else if (seg.type === 9 || seg.type === 13) {
      let byteOffset = (seg.startAddr - 1) * 8;
      for (const state of seg.states) {
        for (const c of state) {
          writeDouble(buf, byteOffset, c);
          byteOffset += 8;
        }
      }
      for (const epoch of seg.epochs) {
        writeDouble(buf, byteOffset, epoch);
        byteOffset += 8;
      }
      // No directory: writeSpk() already rejected states.length > 100.
      writeDouble(buf, byteOffset, seg.degree);
      writeDouble(buf, byteOffset + 8, seg.states.length);
    } else if (seg.type === 5) {
      let byteOffset = (seg.startAddr - 1) * 8;
      for (const state of seg.states) {
        for (const c of state) {
          writeDouble(buf, byteOffset, c);
          byteOffset += 8;
        }
      }
      for (const epoch of seg.epochs) {
        writeDouble(buf, byteOffset, epoch);
        byteOffset += 8;
      }
      // No directory: writeSpk() already rejected states.length > 100.
      writeDouble(buf, byteOffset, seg.gm);
      writeDouble(buf, byteOffset + 8, seg.states.length);
    }
  }

  return buf;
}
