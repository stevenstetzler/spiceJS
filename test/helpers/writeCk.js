/**
 * Test-only encoder for the DAF/CK binary format, used to build
 * synthetic .bc fixtures so ck.js/daf.js can be round-trip tested
 * without a real (and, for CK, licensing-encumbered or hard-to-find)
 * kernel file. Mirrors `writeSpk.js`'s exact scaffolding (file record,
 * summary record, blank name record -- see that file's own doc comment
 * for why the name record has to exist even blank) with CK's own
 * ND=2,NI=6 summary shape and per-type segment layouts (see `ck.js`'s
 * own doc comment, and each `evaluateType*()` function, for the byte
 * layout this necessarily encodes the same understanding of).
 *
 * Every segment here is capped at 100 records/intervals (matching
 * `writeSpk.js`'s own precedent for types 5/9/13/21) so the real
 * on-disk "directory" every CK type also carries never needs writing
 * -- `ck.js`'s own reader ignores it regardless (see that module's
 * doc comment for why that's a safe simplification, not an
 * approximation), but a real CSPICE-compatible file needs it present
 * beyond that count.
 */
import { Buffer } from 'node:buffer';

const FILE_RECORD_BYTES = 1024;
const FIRST_DATA_ADDR = 385; // same layout as writeSpk.js: file record, one summary record, one (blank) name record
const MAX_SEGMENTS_PER_RECORD = 25; // (128 - 3) / 5, for CK's ND=2,NI=6 -> 5 words/summary, same as SPK
const MAX_RECORDS = 100; // no on-disk directory support -- see module doc comment

/**
 * @param {object} opts
 * @param {boolean} [opts.littleEndian]
 * @param {Array<object>} opts.segments - each `{ inst, refFrame, avFlag,
 *   startSclk, stopSclk, type, ... }`, shaped per `type`:
 *   - 1 (discrete): `records: [{ time, quat: [q0,q1,q2,q3], av?: [a1,a2,a3] }]`
 *     (`av` required iff `avFlag === 1`), ascending by `time`, <= 100 entries.
 *   - 2 (fixed angular rate): `intervals: [{ start, stop, quat, av, rate }]`
 *     (always carries av/rate -- `avFlag` should be 1), `start`s ascending,
 *     <= 100 entries.
 *   - 3 (linear interpolation): `records` (as type 1, `av` required iff
 *     `avFlag === 1`) plus `intervalStarts: number[]` (ascending, marking
 *     where a new continuous interval begins -- see `ck.js`'s own doc
 *     comment on `evaluateType3`), each capped at 100 entries.
 * @returns {Buffer}
 */
export function writeCk({ littleEndian = true, segments }) {
  if (segments.length > MAX_SEGMENTS_PER_RECORD) {
    throw new Error(`writeCk (test helper): only up to ${MAX_SEGMENTS_PER_RECORD} segments are supported`);
  }
  for (const seg of segments) {
    const count = seg.type === 2 ? seg.intervals.length : seg.records.length;
    if (count > MAX_RECORDS) {
      throw new Error(`writeCk (test helper): segments are capped at ${MAX_RECORDS} records/intervals (no directory support)`);
    }
    if (seg.type === 3 && seg.intervalStarts.length > MAX_RECORDS) {
      throw new Error(`writeCk (test helper): segments are capped at ${MAX_RECORDS} interval starts (no directory support)`);
    }
  }

  const writeDouble = (buf, offset, value) => (littleEndian ? buf.writeDoubleLE(value, offset) : buf.writeDoubleBE(value, offset));
  const writeInt32 = (buf, offset, value) => (littleEndian ? buf.writeInt32LE(value, offset) : buf.writeInt32BE(value, offset));

  const psizFor = (seg) => (seg.avFlag === 1 ? 7 : 4);

  // First pass: lay out each segment's data and assign addresses.
  let addr = FIRST_DATA_ADDR;
  const laidOut = segments.map((seg) => {
    if (seg.type === 1) {
      const psiz = psizFor(seg);
      const nrec = seg.records.length;
      const startAddr = addr;
      addr += psiz * nrec + nrec + 1; // packets + times + [nrec] (no directory)
      return { ...seg, psiz, nrec, startAddr, endAddr: addr - 1 };
    }
    if (seg.type === 2) {
      const nrec = seg.intervals.length;
      const startAddr = addr;
      addr += nrec * 10; // 8-word packets + starts + stops (no directory, no trailing count word -- see ck.js's own doc comment on how nrec is derived)
      return { ...seg, nrec, startAddr, endAddr: addr - 1 };
    }
    if (seg.type === 3) {
      const psiz = psizFor(seg);
      const numrec = seg.records.length;
      const numint = seg.intervalStarts.length;
      const startAddr = addr;
      addr += psiz * numrec + numrec + numint + 2; // packets + record times + interval starts + [numint, numrec] (no directories)
      return { ...seg, psiz, numrec, numint, startAddr, endAddr: addr - 1 };
    }
    throw new Error(`writeCk (test helper): unsupported segment type ${seg.type}`);
  });

  const totalWords = addr - 1;
  const totalRecords = Math.ceil(totalWords / 128);
  const buf = Buffer.alloc(totalRecords * FILE_RECORD_BYTES);

  // --- File record ---
  buf.write('DAF/CK  ', 0, 'latin1');
  writeInt32(buf, 8, 2); // ND
  writeInt32(buf, 12, 6); // NI
  buf.write('spiceJS synthetic test CK'.padEnd(60, ' '), 16, 'latin1');
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
    writeDouble(buf, sumOffset, seg.startSclk);
    writeDouble(buf, sumOffset + 8, seg.stopSclk);
    writeInt32(buf, sumOffset + 16, seg.inst);
    writeInt32(buf, sumOffset + 20, seg.refFrame);
    writeInt32(buf, sumOffset + 24, seg.type);
    writeInt32(buf, sumOffset + 28, seg.avFlag ?? 0);
    writeInt32(buf, sumOffset + 32, seg.startAddr);
    writeInt32(buf, sumOffset + 36, seg.endAddr);
    sumOffset += 40; // 5 words (ND=2 + NI/2=3) * 8 bytes
  }

  // --- Name record (record 3): blank, but must exist ---
  buf.write(' '.repeat(FILE_RECORD_BYTES), FILE_RECORD_BYTES * 2, 'latin1');

  // --- Segment data ---
  const writePacket = (byteOffset, psiz, record) => {
    writeDouble(buf, byteOffset, record.quat[0]);
    writeDouble(buf, byteOffset + 8, record.quat[1]);
    writeDouble(buf, byteOffset + 16, record.quat[2]);
    writeDouble(buf, byteOffset + 24, record.quat[3]);
    if (psiz === 7) {
      writeDouble(buf, byteOffset + 32, record.av[0]);
      writeDouble(buf, byteOffset + 40, record.av[1]);
      writeDouble(buf, byteOffset + 48, record.av[2]);
    }
    return byteOffset + psiz * 8;
  };

  for (const seg of laidOut) {
    if (seg.type === 1) {
      let byteOffset = (seg.startAddr - 1) * 8;
      for (const record of seg.records) {
        byteOffset = writePacket(byteOffset, seg.psiz, record);
      }
      for (const record of seg.records) {
        writeDouble(buf, byteOffset, record.time);
        byteOffset += 8;
      }
      // No directory: writeCk() already rejected records.length > MAX_RECORDS.
      writeDouble(buf, byteOffset, seg.nrec);
    } else if (seg.type === 2) {
      let byteOffset = (seg.startAddr - 1) * 8;
      for (const interval of seg.intervals) {
        writeDouble(buf, byteOffset, interval.quat[0]);
        writeDouble(buf, byteOffset + 8, interval.quat[1]);
        writeDouble(buf, byteOffset + 16, interval.quat[2]);
        writeDouble(buf, byteOffset + 24, interval.quat[3]);
        writeDouble(buf, byteOffset + 32, interval.av[0]);
        writeDouble(buf, byteOffset + 40, interval.av[1]);
        writeDouble(buf, byteOffset + 48, interval.av[2]);
        writeDouble(buf, byteOffset + 56, interval.rate);
        byteOffset += 64;
      }
      for (const interval of seg.intervals) {
        writeDouble(buf, byteOffset, interval.start);
        byteOffset += 8;
      }
      for (const interval of seg.intervals) {
        writeDouble(buf, byteOffset, interval.stop);
        byteOffset += 8;
      }
      // No directory, no trailing count word -- nrec is re-derived by the
      // reader from the segment's own byte size (see ck.js's evaluateType2()).
    } else if (seg.type === 3) {
      let byteOffset = (seg.startAddr - 1) * 8;
      for (const record of seg.records) {
        byteOffset = writePacket(byteOffset, seg.psiz, record);
      }
      for (const record of seg.records) {
        writeDouble(buf, byteOffset, record.time);
        byteOffset += 8;
      }
      // No directory: writeCk() already rejected records.length > MAX_RECORDS.
      for (const start of seg.intervalStarts) {
        writeDouble(buf, byteOffset, start);
        byteOffset += 8;
      }
      // No directory: writeCk() already rejected intervalStarts.length > MAX_RECORDS.
      writeDouble(buf, byteOffset, seg.numint);
      writeDouble(buf, byteOffset + 8, seg.numrec);
    }
  }

  return buf;
}
