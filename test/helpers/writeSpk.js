/**
 * Test-only encoder for the DAF/SPK binary format, used to build
 * synthetic .bsp fixtures so spk.js/daf.js can be round-trip tested
 * without a real (multi-megabyte, network-fetched) kernel file. Only
 * supports what's needed for that: a single summary record (up to 25
 * segments) of type 2/3/5/8/9/12/13/21 data, both endiannesses.
 *
 * This is the mirror image of src/daf.js + src/spk.js's decoding, so
 * it necessarily encodes the *same* understanding of the format --
 * see src/daf.js's doc comment for the byte layout this follows, and
 * src/math/interpolatedRecord.js's doc comment for types 5/8/9/12/13/21's
 * layout specifically. Types 5/9/13/21 (unequal time step) segments
 * are capped at 100 states/records here so the on-disk "directory" (a
 * lookup-speed optimization for segments with more than that) never
 * needs writing -- spiceJS's own reader ignores the directory
 * regardless, but a real CSPICE-compatible file needs it present
 * beyond that count.
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
 *   - 21 (extended difference lines): `epochs: number[], records:
 *     object[]` (same length as `epochs`, <= 100 entries -- see the
 *     module doc comment), each record `{ tl, g: number[], refPos:
 *     number[3], refVel: number[3], dt: [number[], number[], number[]],
 *     kqmax1, kq: number[3] }` -- exactly interpolatedRecord.js's
 *     readDifferenceLine() shape. Every record must share the same
 *     `g`/`dt` axis length (`maxdim`, stored once in the segment
 *     trailer, same as 5/9/13's `degree`/`gm`). Unlike 5/9/13, `epochs[i]`
 *     here is record `i`'s own *coverage end time*, not its epoch/`tl`
 *     -- record 0 covers `[startEt, epochs[0]]`, record `i>0` covers
 *     `(epochs[i-1], epochs[i]]`, and a well-formed segment's last
 *     `epochs` entry must be `>= stopEt` (see interpolatedRecord.js's
 *     module doc comment for why).
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
    if (seg.type === 21 && seg.records.length > 100) {
      throw new Error('writeSpk (test helper): type 21 segments are capped at 100 records (no directory support)');
    }
    if (seg.type === 21) {
      // Every record's own size (dlsiz = 4*maxdim+11) has to match the
      // *segment's* single maxdim -- laid out once, from records[0],
      // below -- since real spkr21_ (and this reader) only ever store/
      // read one maxdim per segment, not per record. A record with a
      // different g/dt length would silently write past its own
      // allotted slot into the next record (or the epoch array/trailer,
      // for the last one) -- caught here as a clear error instead,
      // rather than corrupting adjacent bytes silently (confirmed live:
      // exactly this mistake, uncaught, produced a bogus giant
      // maxdim/N read back from the corrupted trailer that made the
      // reader appear to hang).
      const maxdim = seg.records[0].g.length;
      for (const [i, record] of seg.records.entries()) {
        if (record.g.length !== maxdim || record.dt.some((axis) => axis.length !== maxdim)) {
          throw new Error(
            `writeSpk (test helper): type 21 record ${i} has g/dt length ${record.g.length}/` +
              `${record.dt.map((axis) => axis.length).join(',')}, but the segment's own maxdim ` +
              `(from record 0) is ${maxdim} -- every record in a segment must share one maxdim`
          );
        }
      }
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
    if (seg.type === 21) {
      const maxdim = seg.records[0].g.length;
      const dlsiz = 4 * maxdim + 11;
      const startAddr = addr;
      addr += seg.records.length * dlsiz + seg.epochs.length + 2; // records + epochs + [maxdim, N] (no directory)
      return { ...seg, maxdim, dlsiz, startAddr, endAddr: addr - 1 };
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
    } else if (seg.type === 21) {
      // One "extended difference line" per record -- layout exactly
      // matches interpolatedRecord.js's readDifferenceLine() (itself
      // confirmed against spke21.c's Detailed_Input): [TL, G(maxdim),
      // refPos/refVel interleaved (6), DT_x/DT_y/DT_z (maxdim each),
      // KQMAX1, KQ(3)] -- 4*maxdim+11 words per record.
      let byteOffset = (seg.startAddr - 1) * 8;
      for (const record of seg.records) {
        writeDouble(buf, byteOffset, record.tl);
        byteOffset += 8;
        for (const g of record.g) {
          writeDouble(buf, byteOffset, g);
          byteOffset += 8;
        }
        for (let axis = 0; axis < 3; axis++) {
          writeDouble(buf, byteOffset, record.refPos[axis]);
          byteOffset += 8;
          writeDouble(buf, byteOffset, record.refVel[axis]);
          byteOffset += 8;
        }
        for (let axis = 0; axis < 3; axis++) {
          for (const d of record.dt[axis]) {
            writeDouble(buf, byteOffset, d);
            byteOffset += 8;
          }
        }
        writeDouble(buf, byteOffset, record.kqmax1);
        byteOffset += 8;
        for (const kq of record.kq) {
          writeDouble(buf, byteOffset, kq);
          byteOffset += 8;
        }
      }
      for (const epoch of seg.epochs) {
        writeDouble(buf, byteOffset, epoch);
        byteOffset += 8;
      }
      // No directory: writeSpk() already rejected records.length > 100.
      writeDouble(buf, byteOffset, seg.maxdim);
      writeDouble(buf, byteOffset + 8, seg.epochs.length);
    }
  }

  return buf;
}
