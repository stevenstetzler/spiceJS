import test from 'node:test';
import assert from 'node:assert/strict';
import { writePck } from '../helpers/writePck.js';
import { loadPck, evaluateSegment, findPckSegment, pckSegments } from '../../src/pck.js';
import { KernelPool } from '../../src/pool.js';
import { prefetchPckQuery } from '../../src/lazy/pckPrefetch.js';
import { openRemotePck } from '../../src/lazy/openRemotePck.js';
import { fakeRemoteFile } from './helpers/fakeRemote.js';
import { multiRecordLinearPckSegment } from './helpers/multiRecordPckSegment.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

test('prefetchPckQuery + ordinary evaluateSegment(): matches the analytic answer exactly', async () => {
  const seg = multiRecordLinearPckSegment({
    frame: 31008,
    a0: [0.1, 0.2, 1.0],
    da: [0.001, -0.0005, 0.02],
    n: 20,
    intlen: 40,
    init: -400,
  });
  const buf = writePck({ segments: [seg] });
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchPckQuery(remoteFile, pool, { frame: 31008, etStart: -50, etEnd: 50 });

  const et = 12;
  const segment = findPckSegment(pool, 31008, et);
  assert.ok(segment);
  const { eulerAngles, eulerRates } = evaluateSegment(segment, et);
  const expected = seg.expectedAt(et);
  eulerAngles.forEach((a, i) => closeTo(a, expected.eulerAngles[i], 1e-9));
  eulerRates.forEach((r, i) => closeTo(r, expected.eulerRates[i], 1e-9));
});

test('is bit-identical to the eager (furnsh-equivalent) path on the same bytes', async () => {
  const seg = multiRecordLinearPckSegment({
    frame: 31008,
    a0: [0.1, 0.2, 1.0],
    da: [0.001, -0.0005, 0.02],
    n: 20,
    intlen: 40,
    init: -400,
  });
  const buf = writePck({ segments: [seg] });
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });

  const lazyPool = new KernelPool();
  await prefetchPckQuery(remoteFile, lazyPool, { frame: 31008, etStart: -50, etEnd: 50 });

  const eagerPool = new KernelPool();
  eagerPool.addPckSegments(loadPck(buf));

  for (const et of [-40, -12, 0, 8.5, 33]) {
    const lazyResult = evaluateSegment(findPckSegment(lazyPool, 31008, et), et);
    const eagerResult = evaluateSegment(findPckSegment(eagerPool, 31008, et), et);
    assert.deepEqual(lazyResult, eagerResult);
  }
});

test('querying an et outside the prefetched window throws the "not prefetched" error, not a wrong answer', async () => {
  const seg = multiRecordLinearPckSegment({
    frame: 31008,
    a0: [0.1, 0.2, 1.0],
    da: [0.001, -0.0005, 0.02],
    n: 20,
    intlen: 40,
    init: -400,
  });
  const buf = writePck({ segments: [seg] });
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchPckQuery(remoteFile, pool, { frame: 31008, etStart: -50, etEnd: 50 });

  const et = 300; // inside the segment's overall coverage, far outside the prefetched window
  const segment = findPckSegment(pool, 31008, et);
  assert.ok(segment); // coverage check passes -- this exercises the checkRange safety net specifically
  assert.throws(() => evaluateSegment(segment, et), /was not prefetched/);
});

test('prefetch() is idempotent -- repeated calls do not duplicate pool segments', async () => {
  const seg = multiRecordLinearPckSegment({
    frame: 31008,
    a0: [0.1, 0.2, 1.0],
    da: [0.001, -0.0005, 0.02],
    n: 20,
    intlen: 40,
    init: -400,
  });
  const buf = writePck({ segments: [seg] });
  const { remoteFile, requests } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchPckQuery(remoteFile, pool, { frame: 31008, etStart: -50, etEnd: 50 });
  const afterFirst = pckSegments(pool).length;
  const requestsAfterFirst = requests.length;

  await prefetchPckQuery(remoteFile, pool, { frame: 31008, etStart: -50, etEnd: 50 });
  assert.equal(pckSegments(pool).length, afterFirst);
  assert.equal(requests.length, requestsAfterFirst);
});

test('openRemotePck(): the public entry point, end to end (custom resolveRange, no real network)', async () => {
  const seg = multiRecordLinearPckSegment({
    frame: 10013, // IAU_MARS-shaped ID, arbitrary for this test
    a0: [0.05, -0.1, 2.0],
    da: [0.0002, 0.0001, 0.03],
    n: 10,
    intlen: 500,
    init: -2500,
  });
  const buf = writePck({ segments: [seg] });
  const requests = [];

  const remote = await openRemotePck('fake://kernel.bpc', {
    fileLength: buf.byteLength,
    resolveRange: async (url, startByte, endByteExclusive) => {
      requests.push([startByte, endByteExclusive]);
      return buf.subarray(startByte, endByteExclusive);
    },
  });

  await remote.prefetch({ frame: 10013, etStart: -100, etEnd: 100 });
  assert.ok(requests.length > 0);

  const et = 42;
  const segment = findPckSegment(remote.pool, 10013, et);
  const { eulerAngles, eulerRates } = evaluateSegment(segment, et);
  const expected = seg.expectedAt(et);
  eulerAngles.forEach((a, i) => closeTo(a, expected.eulerAngles[i], 1e-9));
  eulerRates.forEach((r, i) => closeTo(r, expected.eulerRates[i], 1e-9));
});
