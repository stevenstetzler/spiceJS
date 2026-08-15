import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSpk } from '../helpers/writeSpk.js';
import { loadSpk, spkez, spkSegments } from '../../src/spk.js';
import { KernelPool } from '../../src/pool.js';
import { prefetchSpkQuery } from '../../src/lazy/prefetch.js';
import { fakeRemoteFile } from './helpers/fakeRemote.js';
import { multiRecordLinearSegment } from './helpers/multiRecordSegment.js';
import { equalStepLinearSegment } from './helpers/equalStepSegment.js';
import { unequalStepLinearSegment } from './helpers/unequalStepSegment.js';
import { circularOrbitSegment } from './helpers/type5Segment.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

function addState(a, b) {
  return a.map((v, i) => v + b[i]);
}

// Earth(399) rel EMB(3), and EMB(3) rel SSB(0) -- mirrors the real
// de440s.bsp chain this whole feature was scoped against (see
// docs/lazy-loading.md), synthetic but same shape: two hops, small
// enough to build/verify by hand.
function earthEmbSsbFixture() {
  const earthRelEmb = multiRecordLinearSegment({
    target: 399,
    center: 3,
    p0: [7000, -200, 50],
    v0: [1.2, -0.8, 0.05],
    n: 20,
    intlen: 40,
    init: -400,
  });
  const embRelSsb = multiRecordLinearSegment({
    target: 3,
    center: 0,
    p0: [1.5e8, 0, 0],
    v0: [0, 29.8, 0.1],
    n: 10,
    intlen: 160,
    init: -800,
  });
  const buf = writeSpk({ segments: [earthRelEmb, embRelSsb] });
  return { buf, earthRelEmb, embRelSsb };
}

test('prefetchSpkQuery + ordinary spkez(): matches the analytic two-hop chain answer exactly', async () => {
  const { buf, earthRelEmb, embRelSsb } = earthEmbSsbFixture();
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: -50, etEnd: 50 });

  const et = 12;
  const { position, velocity } = spkez(399, 0, et, 'NONE', null, pool);
  const expected = addState(
    Object.values(earthRelEmb.expectedStateAt(et)).flat(),
    Object.values(embRelSsb.expectedStateAt(et)).flat()
  );
  [...position, ...velocity].forEach((v, i) => closeTo(v, expected[i], 1e-6));
});

test('is bit-identical to the eager (furnsh-equivalent) path on the same bytes', async () => {
  const { buf } = earthEmbSsbFixture();
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });

  const lazyPool = new KernelPool();
  await prefetchSpkQuery(remoteFile, lazyPool, { target: 399, observer: 0, etStart: -50, etEnd: 50 });

  const eagerPool = new KernelPool();
  eagerPool.addSpkSegments(loadSpk(buf));

  for (const et of [-40, -12, 0, 8.5, 33]) {
    const lazyResult = spkez(399, 0, et, 'NONE', null, lazyPool);
    const eagerResult = spkez(399, 0, et, 'NONE', null, eagerPool);
    assert.deepEqual(lazyResult, eagerResult);
  }
});

test('querying an et outside the prefetched window throws the "not prefetched" error, not a wrong answer', async () => {
  const { buf } = earthEmbSsbFixture();
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: -50, etEnd: 50 });

  // Well outside the prefetched window, but still inside the
  // segment's own overall coverage -- so this exercises the
  // checkRange safety net, not findChainToSsb's own coverage check.
  assert.throws(() => spkez(399, 0, 350, 'NONE', null, pool), /was not prefetched/);
});

test('prefetch() is idempotent -- repeated calls do not duplicate pool segments', async () => {
  const { buf } = earthEmbSsbFixture();
  const { remoteFile, requests } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: -50, etEnd: 50 });
  const afterFirst = spkSegments(pool).length;
  const requestsAfterFirst = requests.length;

  await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: -50, etEnd: 50 });
  assert.equal(spkSegments(pool).length, afterFirst);
  assert.equal(requests.length, requestsAfterFirst); // already-populated blocks -- no new network requests either

  // A genuinely wider window does trigger new fetches, but still no duplicate segments.
  await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: -300, etEnd: 300 });
  assert.equal(spkSegments(pool).length, afterFirst);
});

test('chains through multiple hops to reach the Solar System Barycenter', async () => {
  const moonRelEarth = multiRecordLinearSegment({
    target: 301,
    center: 399,
    p0: [384000, 0, 0],
    v0: [0, 1.0, 0],
    n: 6,
    intlen: 200,
    init: -600,
  });
  const earthRelEmb = multiRecordLinearSegment({
    target: 399,
    center: 3,
    p0: [4000, 0, 0],
    v0: [0.1, 0, 0],
    n: 6,
    intlen: 200,
    init: -600,
  });
  const embRelSsb = multiRecordLinearSegment({
    target: 3,
    center: 0,
    p0: [1.5e8, 0, 0],
    v0: [0, 29.8, 0],
    n: 6,
    intlen: 200,
    init: -600,
  });
  const buf = writeSpk({ segments: [moonRelEarth, earthRelEmb, embRelSsb] });
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchSpkQuery(remoteFile, pool, { target: 301, observer: 0, etStart: -10, etEnd: 10 });
  assert.equal(spkSegments(pool).length, 3); // all three hops fetched

  const et = 3;
  const { position } = spkez(301, 0, et, 'NONE', null, pool);
  const expected = [moonRelEarth, earthRelEmb, embRelSsb]
    .map((s) => s.expectedStateAt(et).position)
    .reduce((a, b) => addState(a, b));
  position.forEach((p, i) => closeTo(p, expected[i], 1e-6));
});

test('target and observer with independent chains sharing a common ancestor -- observer != SSB', async () => {
  const { buf, earthRelEmb, embRelSsb } = earthEmbSsbFixture();
  const moonRelEmb = multiRecordLinearSegment({
    target: 301,
    center: 3,
    p0: [380000, 5000, 0],
    v0: [0.2, 0.9, 0],
    n: 20,
    intlen: 40,
    init: -400,
  });
  const bufWithMoon = writeSpk({ segments: [earthRelEmb, embRelSsb, moonRelEmb] });
  const { remoteFile } = fakeRemoteFile(bufWithMoon, { blockBytes: 128 });
  const pool = new KernelPool();

  // Earth relative to the Moon: both chain through EMB(3) to the SSB;
  // the shared EMB-rel-SSB segment must only be fetched/added once.
  await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 301, etStart: -50, etEnd: 50 });
  assert.equal(spkSegments(pool).length, 3); // earthRelEmb + embRelSsb + moonRelEmb, no duplicates

  const et = 10;
  const { position } = spkez(399, 301, et, 'NONE', null, pool);
  const earthAbs = addState(earthRelEmb.expectedStateAt(et).position, embRelSsb.expectedStateAt(et).position);
  const moonAbs = addState(moonRelEmb.expectedStateAt(et).position, embRelSsb.expectedStateAt(et).position);
  const expected = earthAbs.map((v, i) => v - moonAbs[i]);
  position.forEach((p, i) => closeTo(p, expected[i], 1e-6));
});

test('prefetchSpkQuery rejects etStart > etEnd', async () => {
  const { buf } = earthEmbSsbFixture();
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();
  await assert.rejects(
    () => prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: 50, etEnd: -50 }),
    /etStart .* must be <= etEnd/
  );
});

test('prefetchSpkQuery throws clearly when no segment covers the query window for a body in the chain', async () => {
  const { buf } = earthEmbSsbFixture(); // covers roughly [-800, 800]
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();
  await assert.rejects(
    () => prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: 5000, etEnd: 6000 }),
    /no segment found/
  );
});

test('lightTimeMargin widens the fetched window so a light-time-shifted et is already covered', async () => {
  const { buf } = earthEmbSsbFixture();
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
  const pool = new KernelPool();

  await prefetchSpkQuery(remoteFile, pool, {
    target: 399,
    observer: 0,
    etStart: -10,
    etEnd: 10,
    lightTimeMargin: 100,
  });

  // 90 is outside [-10, 10] but inside the 100-second margin.
  assert.doesNotThrow(() => spkez(399, 0, 90, 'NONE', null, pool));
  // 250 is outside even the margined window.
  assert.throws(() => spkez(399, 0, 250, 'NONE', null, pool), /was not prefetched/);
});

for (const type of [8, 12]) {
  test(`prefetchSpkQuery + ordinary spkez() over a heterogeneous chain (type 2/3 hop + type ${type} hop)`, async () => {
    const earthRelEmb = multiRecordLinearSegment({
      target: 399,
      center: 3,
      p0: [7000, -200, 50],
      v0: [1.2, -0.8, 0.05],
      n: 20,
      intlen: 40,
      init: -400,
    });
    const embRelSsb = {
      ...equalStepLinearSegment({
        target: 3,
        center: 0,
        p0: [1.5e8, 0, 0],
        v0: [0, 29.8, 0.1],
        n: 12,
        step: 80,
        begin: -480,
      }),
      type,
    };
    const buf = writeSpk({ segments: [earthRelEmb, embRelSsb] });
    const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
    const pool = new KernelPool();

    await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: -50, etEnd: 50 });

    const et = 12;
    const { position, velocity } = spkez(399, 0, et, 'NONE', null, pool);
    const expected = addState(
      Object.values(earthRelEmb.expectedStateAt(et)).flat(),
      Object.values(embRelSsb.expectedStateAt(et)).flat()
    );
    [...position, ...velocity].forEach((v, i) => closeTo(v, expected[i], 1e-6));

    // Same "not prefetched" safety net as the pure type-2/3 chain --
    // 300 is inside both segments' *overall* declared coverage (so
    // this isn't just chainStateToSsb's ordinary "no coverage" check),
    // but well outside the narrower [-50, 50] window actually prefetched.
    assert.throws(() => spkez(399, 0, 300, 'NONE', null, pool), /was not prefetched/);
  });
}

for (const type of [9, 13]) {
  test(`prefetchSpkQuery + ordinary spkez() over a heterogeneous chain (type 2/3 hop + type ${type} hop)`, async () => {
    const earthRelEmb = multiRecordLinearSegment({
      target: 399,
      center: 3,
      p0: [7000, -200, 50],
      v0: [1.2, -0.8, 0.05],
      n: 20,
      intlen: 40,
      init: -400,
    });
    const embRelSsb = {
      ...unequalStepLinearSegment({
        target: 3,
        center: 0,
        p0: [1.5e8, 0, 0],
        v0: [0, 29.8, 0.1],
        epochs: [-480, -400, -250, -100, 0, 100, 250, 400],
      }),
      type,
    };
    const buf = writeSpk({ segments: [earthRelEmb, embRelSsb] });
    const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 128 });
    const pool = new KernelPool();

    await prefetchSpkQuery(remoteFile, pool, { target: 399, observer: 0, etStart: -50, etEnd: 50 });

    const et = 12;
    const { position, velocity } = spkez(399, 0, et, 'NONE', null, pool);
    const expected = addState(
      Object.values(earthRelEmb.expectedStateAt(et)).flat(),
      Object.values(embRelSsb.expectedStateAt(et)).flat()
    );
    [...position, ...velocity].forEach((v, i) => closeTo(v, expected[i], 1e-6));

    // 300 is inside both segments' overall coverage, but well outside
    // the narrower [-50, 50] window actually prefetched.
    assert.throws(() => spkez(399, 0, 300, 'NONE', null, pool), /was not prefetched/);
  });
}

test('prefetchSpkQuery + ordinary spkez() for a type 5 (two-body propagation) segment', async () => {
  const epochs = [-500, -100, 300, 900];
  const seg = circularOrbitSegment({ target: 499, center: 0, epochs });
  const buf = writeSpk({ segments: [seg] });
  // A fine blockBytes here, deliberately -- this tiny synthetic file's
  // 4 states are close enough together in byte terms that a coarser
  // (e.g. 128-byte) block size would coincidentally sweep the
  // unprefetched bracket's bytes into the same populated blocks as
  // the prefetched one, via ordinary block-rounding (see
  // remoteFile.test.js for that coalescing behavior in isolation) --
  // not a bug, just not what this test is trying to demonstrate.
  const { remoteFile } = fakeRemoteFile(buf, { blockBytes: 8 });
  const pool = new KernelPool();

  await prefetchSpkQuery(remoteFile, pool, { target: 499, observer: 0, etStart: -50, etEnd: 50 });

  const et = 20;
  const { position, velocity } = spkez(499, 0, et, 'NONE', null, pool);
  const expected = seg.expectedStateAt(et);
  [...position, ...velocity].forEach((v, i) => closeTo(v, [...expected.position, ...expected.velocity][i], 1e-6));

  // 700 is within the segment's overall [-500, 900] coverage, but its
  // bracket (epochs[2]=300, epochs[3]=900) is nowhere near the one
  // prefetched for [-50, 50] (epochs[1]=-100, epochs[2]=300).
  assert.throws(() => spkez(499, 0, 700, 'NONE', null, pool), /was not prefetched/);
});
