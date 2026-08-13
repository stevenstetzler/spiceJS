import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileRecord, parseDaf, readWords } from '../src/daf.js';
import { writeSpk } from './helpers/writeSpk.js';

function linearSegment(overrides = {}) {
  return {
    target: 499,
    center: 10,
    frame: 1,
    type: 2,
    startEt: 0,
    stopEt: 100,
    init: 0,
    intlen: 100,
    records: [{ mid: 50, radius: 50, coeffsByAxis: [[1000, 10], [2000, 20], [3000, 30]] }],
    ...overrides,
  };
}

test('parseFileRecord reads ID word, ND/NI, FWARD/BWARD, and endianness', () => {
  const buf = writeSpk({ littleEndian: true, segments: [linearSegment()] });
  const fr = parseFileRecord(buf);
  assert.equal(fr.idWord, 'DAF/SPK');
  assert.equal(fr.nd, 2);
  assert.equal(fr.ni, 6);
  assert.equal(fr.fward, 2);
  assert.equal(fr.bward, 2);
  assert.equal(fr.littleEndian, true);
});

test('parseFileRecord reads big-endian files too', () => {
  const buf = writeSpk({ littleEndian: false, segments: [linearSegment()] });
  const fr = parseFileRecord(buf);
  assert.equal(fr.littleEndian, false);
});

test('parseFileRecord rejects a non-DAF file', () => {
  const buf = Buffer.from('this is not a DAF file at all, just text padding out to 1024+ bytes\n'.repeat(20));
  assert.throws(() => parseFileRecord(buf), /not a DAF file/);
});

test('parseFileRecord accepts the generic "NAIF/DAF" ID word (used by real, older SPK/PCK files)', () => {
  const buf = writeSpk({ segments: [linearSegment()] });
  buf.write('NAIF/DAF', 0, 'latin1');
  const fr = parseFileRecord(buf);
  assert.equal(fr.idWord, 'NAIF/DAF');
  assert.equal(fr.nd, 2);
  assert.equal(fr.ni, 6);
});

test('parseDaf decodes summaries into dc/ic arrays', () => {
  const buf = writeSpk({
    segments: [linearSegment({ target: 499, center: 10, frame: 17, type: 2, startEt: -10, stopEt: 90 })],
  });
  const daf = parseDaf(buf);
  assert.equal(daf.nd, 2);
  assert.equal(daf.ni, 6);
  assert.equal(daf.summaries.length, 1);
  const [{ dc, ic }] = daf.summaries;
  assert.deepEqual(dc, [-10, 90]);
  const [target, center, frame, type, startAddr, endAddr] = ic;
  assert.equal(target, 499);
  assert.equal(center, 10);
  assert.equal(frame, 17);
  assert.equal(type, 2);
  assert.ok(startAddr > 0 && endAddr >= startAddr);
});

test('parseDaf decodes multiple summaries in one record', () => {
  const buf = writeSpk({
    segments: [
      linearSegment({ target: 499, center: 10 }),
      linearSegment({ target: 301, center: 399 }),
      linearSegment({ target: 399, center: 0 }),
    ],
  });
  const daf = parseDaf(buf);
  assert.equal(daf.summaries.length, 3);
  assert.deepEqual(
    daf.summaries.map((s) => [s.ic[0], s.ic[1]]),
    [
      [499, 10],
      [301, 399],
      [399, 0],
    ]
  );
});

test('readWords reads a 1-based inclusive address range', () => {
  const buf = writeSpk({ segments: [linearSegment()] });
  const daf = parseDaf(buf);
  const { ic } = daf.summaries[0];
  const [, , , , startAddr, endAddr] = ic;
  const words = readWords(buf, true, startAddr, endAddr);
  // record: [mid=50, radius=50, X0=1000, X1=10, Y0=2000, Y1=20, Z0=3000, Z1=30], then epilog [0, 100, 8, 1]
  assert.deepEqual(Array.from(words), [50, 50, 1000, 10, 2000, 20, 3000, 30, 0, 100, 8, 1]);
});
