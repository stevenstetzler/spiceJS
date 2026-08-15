import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSpk } from '../helpers/writeSpk.js';
import { loadSpk, evaluateSegment } from '../../src/spk.js';
import { byteRangeForQuery } from '../../src/lazy/byteRange.js';
import { fakeRemoteFile } from './helpers/fakeRemote.js';
import { multiRecordLinearSegment } from './helpers/multiRecordSegment.js';
import { equalStepLinearSegment } from './helpers/equalStepSegment.js';
import { unequalStepLinearSegment } from './helpers/unequalStepSegment.js';
import { circularOrbitSegment } from './helpers/type5Segment.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

test('byteRangeForQuery (type 2/3): exact record-index arithmetic, cross-checked against the formula by hand', async () => {
  const seg = multiRecordLinearSegment({
    target: 399,
    center: 3,
    p0: [7000, 0, 0],
    v0: [1, 2, 3],
    n: 10,
    intlen: 100,
    init: 0,
  });
  const buf = writeSpk({ segments: [seg] });
  const [{ startAddr, endAddr, type }] = loadSpk(buf);
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });

  const range = await byteRangeForQuery(
    remoteFile,
    { type, startAddr, endAddr, buffer: remoteFile.buffer, littleEndian: true },
    250,
    320
  );

  const recordSize = 8; // [mid, radius, X0, X1, Y0, Y1, Z0, Z1]
  const recnoStart = Math.floor(250 / 100); // 2
  const recnoEnd = Math.floor(320 / 100); // 3
  const wordStart = startAddr + recnoStart * recordSize;
  const wordEndExclusive = startAddr + (recnoEnd + 1) * recordSize;
  assert.deepEqual(range, { startByte: (wordStart - 1) * 8, endByteExclusive: (wordEndExclusive - 1) * 8 });
});

test('byteRangeForQuery clamps to the first/last record for a query outside the segment\'s own coverage', async () => {
  const seg = multiRecordLinearSegment({ target: 399, center: 3, p0: [0, 0, 0], v0: [1, 0, 0], n: 5, intlen: 100 });
  const buf = writeSpk({ segments: [seg] });
  const [{ startAddr, endAddr, type }] = loadSpk(buf);
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });
  const segment = { type, startAddr, endAddr, buffer: remoteFile.buffer, littleEndian: true };

  const recordSize = 8;
  const before = await byteRangeForQuery(remoteFile, segment, -5000, -1000);
  assert.deepEqual(before, { startByte: (startAddr - 1) * 8, endByteExclusive: (startAddr - 1 + recordSize) * 8 });

  const after = await byteRangeForQuery(remoteFile, segment, 10000, 20000);
  const lastRecordWordStart = startAddr + 4 * recordSize; // n=5 -> last recno is 4
  assert.deepEqual(after, {
    startByte: (lastRecordWordStart - 1) * 8,
    endByteExclusive: (lastRecordWordStart - 1 + recordSize) * 8,
  });
});

test('byteRangeForQuery fetches its own epilog -- the caller does not need to ensureRange it first', async () => {
  const seg = multiRecordLinearSegment({ target: 399, center: 3, p0: [0, 0, 0], v0: [1, 0, 0], n: 5, intlen: 100 });
  const buf = writeSpk({ segments: [seg] });
  const [{ startAddr, endAddr, type }] = loadSpk(buf);
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });
  const segment = { type, startAddr, endAddr, buffer: remoteFile.buffer, littleEndian: true };

  assert.ok(!remoteFile.isPopulated((endAddr - 4) * 8, endAddr * 8));
  await byteRangeForQuery(remoteFile, segment, 0, 50);
  assert.ok(remoteFile.isPopulated((endAddr - 4) * 8, endAddr * 8));
});

test('a segment read entirely through the byte range byteRangeForQuery computes gives the correct evaluated state', async () => {
  const seg = multiRecordLinearSegment({
    target: 399,
    center: 3,
    p0: [7000, -200, 50],
    v0: [1.5, -2.25, 0.1],
    n: 12,
    intlen: 50,
    init: -300,
  });
  const buf = writeSpk({ segments: [seg] });
  const [loaded] = loadSpk(buf);
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });

  const queryEt = 37; // inside the segment's coverage, not near a record boundary
  const range = await byteRangeForQuery(remoteFile, loaded, queryEt, queryEt);
  await remoteFile.ensureRange(range.startByte, range.endByteExclusive);

  const lazySegment = { ...loaded, buffer: remoteFile.buffer };
  const { position, velocity } = evaluateSegment(lazySegment, queryEt);
  const expected = seg.expectedStateAt(queryEt);
  position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
  velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
});

test('byteRangeForQuery rejects an unsupported segment type', async () => {
  const seg = multiRecordLinearSegment({ target: 399, center: 3, p0: [0, 0, 0], v0: [1, 0, 0] });
  const buf = writeSpk({ segments: [seg] });
  const [{ startAddr }] = loadSpk(buf);
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });

  // Type 1 (modified difference arrays) -- deliberately out of scope,
  // same as spk.js's own evaluateSegment().
  await assert.rejects(
    () => byteRangeForQuery(remoteFile, { type: 1, startAddr }, 0, 50),
    /not supported for lazy loading yet/
  );
});

for (const type of [8, 12]) {
  test(`byteRangeForQuery (type ${type}): exact state-index-window arithmetic, cross-checked by hand`, async () => {
    const seg = { ...equalStepLinearSegment({ target: 499, center: 10, p0: [0, 0, 0], v0: [1, 0, 0], n: 12, step: 40, begin: -240 }), type };
    const buf = writeSpk({ segments: [seg] });
    const [{ startAddr, endAddr }] = loadSpk(buf);
    const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });
    const segment = { type, startAddr, endAddr, buffer: remoteFile.buffer, littleEndian: true };

    // Query window [10, 90] -> nearIdx0 spans roughly indices 6..8 for
    // degree=3 (window size 4), odd -> Math.round anchoring.
    const range = await byteRangeForQuery(remoteFile, segment, 10, 90);

    // Hand-computed via the same windowStart()/degree=3 rule daf.js's
    // interpolatedRecord.js documents (windowStart = clamp(near - floor(degree/2), 0, n-1-degree)).
    const degree = 3;
    const nearAt = (et) => Math.round((et - -240) / 40); // odd window size -> nearest-index rounding
    const windowStartAt = (near) => Math.min(Math.max(near - Math.floor(degree / 2), 0), seg.n - 1 - degree);
    const firstIndex = windowStartAt(nearAt(10));
    const lastIndexExclusive = windowStartAt(nearAt(90)) + (degree + 1);
    const wordStart = startAddr + firstIndex * 6;
    const wordEndExclusive = startAddr + lastIndexExclusive * 6;
    assert.deepEqual(range, { startByte: (wordStart - 1) * 8, endByteExclusive: (wordEndExclusive - 1) * 8 });
  });

  test(`byteRangeForQuery (type ${type}): reading exactly that range gives the correct evaluated state`, async () => {
    const seg = {
      ...equalStepLinearSegment({ target: 499, center: 10, p0: [7000, -50, 12], v0: [1.1, 0.3, -0.2], n: 15, step: 30, begin: -210 }),
      type,
    };
    const buf = writeSpk({ segments: [seg] });
    const [loaded] = loadSpk(buf);
    const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });

    const queryEt = 42;
    const range = await byteRangeForQuery(remoteFile, loaded, queryEt, queryEt);
    await remoteFile.ensureRange(range.startByte, range.endByteExclusive);

    const lazySegment = { ...loaded, buffer: remoteFile.buffer };
    const { position, velocity } = evaluateSegment(lazySegment, queryEt);
    const expected = seg.expectedStateAt(queryEt);
    position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
    velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
  });
}

for (const type of [9, 13]) {
  test(`byteRangeForQuery (type ${type}): a two-step fetch (trailer, then epoch array) precedes the state range`, async () => {
    const epochs = [-500, -300, -100, 50, 200, 450, 700, 900]; // deliberately non-uniform
    const seg = { ...unequalStepLinearSegment({ target: 499, center: 10, p0: [1000, 2000, 3000], v0: [1, -2, 0.5], epochs }), type };
    const buf = writeSpk({ segments: [seg] });
    const [loaded] = loadSpk(buf);
    const { remoteFile, requests } = fakeRemoteFile(buf, { blockBytes: 64 });

    const queryEt = 63;
    await byteRangeForQuery(remoteFile, loaded, queryEt, queryEt);

    // At least two distinct fetches happened (trailer, then epoch
    // array -- possibly more once block-coalescing is in play, but
    // never just one, since the epoch array's address depends on N,
    // which is only known after the trailer is read).
    assert.ok(requests.length >= 2, `expected at least 2 requests, got ${requests.length}`);
  });

  test(`byteRangeForQuery (type ${type}): reading exactly that range gives the correct evaluated state`, async () => {
    const epochs = [-500, -300, -100, 50, 200, 450, 700, 900];
    const seg = {
      ...unequalStepLinearSegment({ target: 499, center: 10, p0: [7000, -50, 12], v0: [1.1, 0.3, -0.2], epochs }),
      type,
    };
    const buf = writeSpk({ segments: [seg] });
    const [loaded] = loadSpk(buf);
    const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });

    const queryEt = 63; // strictly inside the non-uniform epoch range
    const range = await byteRangeForQuery(remoteFile, loaded, queryEt, queryEt);
    await remoteFile.ensureRange(range.startByte, range.endByteExclusive);

    const lazySegment = { ...loaded, buffer: remoteFile.buffer };
    const { position, velocity } = evaluateSegment(lazySegment, queryEt);
    const expected = seg.expectedStateAt(queryEt);
    position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
    velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
  });
}

test('byteRangeForQuery (type 5): reading exactly that range gives the correct evaluated (propagated) state', async () => {
  const epochs = [-500, -100, 300, 900];
  const seg = circularOrbitSegment({ target: 499, center: 10, epochs });
  const buf = writeSpk({ segments: [seg] });
  const [loaded] = loadSpk(buf);
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });

  for (const queryEt of [-500, -300, 0, 300, 550, 900]) {
    const range = await byteRangeForQuery(remoteFile, loaded, queryEt, queryEt);
    await remoteFile.ensureRange(range.startByte, range.endByteExclusive);

    const lazySegment = { ...loaded, buffer: remoteFile.buffer };
    const { position, velocity } = evaluateSegment(lazySegment, queryEt);
    const expected = seg.expectedStateAt(queryEt);
    position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
    velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-9));
  }
});

test('byteRangeForQuery (type 5): a query range spanning several brackets fetches their full union', async () => {
  const epochs = [-500, -100, 300, 900];
  const seg = circularOrbitSegment({ target: 499, center: 10, epochs });
  const buf = writeSpk({ segments: [seg] });
  const [loaded] = loadSpk(buf);
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 64 });

  // [-300, 500] touches brackets (epochs[0],epochs[1]), (epochs[1],epochs[2]), (epochs[2],epochs[3])
  // -- i.e. state indices 0..3 (all of them).
  const range = await byteRangeForQuery(remoteFile, loaded, -300, 500);
  await remoteFile.ensureRange(range.startByte, range.endByteExclusive);

  for (const et of [-300, -100, 0, 300, 500]) {
    const lazySegment = { ...loaded, buffer: remoteFile.buffer };
    const { position } = evaluateSegment(lazySegment, et);
    const expected = seg.expectedStateAt(et);
    position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
  }
});
