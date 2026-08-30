import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../src/load.js';
import { KernelPool } from '../src/pool.js';
import { scPartitions, scTicksForFields, scEncode, scDecode, sclkToEt, etToSclk, etToSclkDiscrete } from '../src/sclk.js';
import { writeSclkKernel } from './helpers/writeSclkKernel.js';

const SC = -100001;

function closeTo(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} to be close to ${expected}`);
}

// Two fields: a "RIM"-like field (mod 1,000,000) and a centisecond-ish
// fine field (mod 100, offset 0) -- 100 ticks/second while rate=1
// (below tick 500000), then 50 ticks/second (rate=2) after it, purely
// to exercise the piecewise/multi-breakpoint math, not to model a real
// spacecraft. Two partitions of equal duration (10,000,000 ticks each)
// so partition-boundary continuity can be checked directly.
async function loadTestClock(pool) {
  const text = writeSclkKernel({
    sc: SC,
    moduli: [1000000, 100],
    offsets: [0, 0],
    outputDelim: 2, // ':'
    partitions: [
      { start: 0, stop: 9999999 },
      { start: 20000000, stop: 29999999 }, // a real clock reset: partition 2's own field values restart far from partition 1's own end
    ],
    coefficients: [
      { ticks: 0, time: 0, rate: 1 },
      { ticks: 500000, time: 5000, rate: 2 },
    ],
  });
  await load(new TextEncoder().encode(text), pool);
}

test('scPartitions reads start/stop ticks', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  const { starts, stops } = scPartitions(SC, pool);
  assert.deepEqual(starts, [0, 20000000]);
  assert.deepEqual(stops, [9999999, 29999999]);
});

test('scTicksForFields combines fields via mixed-radix place values', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  // field0=5 (place value 100), field1=42 -> 5*100+42 = 542.
  assert.equal(scTicksForFields(SC, '5:42', pool), 542);
  // A trailing omitted field is assumed 0.
  assert.equal(scTicksForFields(SC, '5', pool), 500);
  // A blank (doubled-delimiter) field is also 0.
  assert.equal(scTicksForFields(SC, '5:', pool), 500);
});

test('scEncode: explicit partition, matches raw field ticks within partition 1', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  assert.equal(scEncode(SC, '1/5:42', pool), 542);
});

test('scEncode: default (omitted) partition picks the one containing the ticks', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  assert.equal(scEncode(SC, '5:42', pool), 542); // falls in partition 1
});

test('scEncode: partition 2 offsets by every earlier partition\'s own duration', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  // Raw ticks 20,050,007 in partition 2 (field0=200500, field1=07) is
  // 50,007 ticks past partition 2's own start (20,000,000); partition
  // 1's own duration (pstop-pstart) is 9,999,999. Encoded SCLK is
  // continuous across the reset: 50,007 + 9,999,999 = 10,050,006.
  assert.equal(scEncode(SC, '2/200500:07', pool), 10050006);
});

test('scEncode: a partition boundary encodes identically from either side', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  // Partition 1's own end (raw ticks 9,999,999 = field0=99999,field1=99)
  // and partition 2's own start (raw ticks 20,000,000 = field0=200000,field1=0)
  // are the same physical instant -- scencd.c's own documented case.
  const end1 = scEncode(SC, `1/99999:99`, pool);
  const start2 = scEncode(SC, `2/200000:0`, pool);
  assert.equal(end1, start2);
});

test('scEncode throws for a partition number out of range', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  assert.throws(() => scEncode(SC, '3/0:0', pool), /partition number 3/);
});

test('scEncode throws when no partition contains the given ticks', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  assert.throws(() => scEncode(SC, '150000:0', pool), /does not fall in the boundaries of any partition/);
});

test('scEncode throws on a malformed clock string', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  assert.throws(() => scEncode(SC, '5:abc', pool), /could not parse/);
});

test('scDecode is the exact inverse of scEncode, round-tripped across both partitions', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  // scDecode() always produces the fully zero-padded canonical form
  // (matching real scdecd_c), so round-trip with already-canonical
  // input strings rather than the more abbreviated ones scEncode()
  // itself tolerates (see the separate scTicksForFields test above for
  // that leniency) -- and away from the exact partition-1/2 boundary,
  // which by design encodes identically from either side (see the
  // dedicated boundary test above) and so isn't round-trip-stable
  // through a single canonical decode.
  for (const clockString of ['1/000005:42', '1/099998:99', '2/200001:00', '2/200500:07']) {
    const ticks = scEncode(SC, clockString, pool);
    assert.equal(scDecode(SC, ticks, pool), clockString);
  }
});

test('scDecode zero-pads fields to their modulus width', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  assert.equal(scDecode(SC, 7, pool), '1/000000:07');
});

test('sclkToEt: exact value at a coefficient breakpoint', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  closeTo(sclkToEt(SC, 0, pool), 0);
  closeTo(sclkToEt(SC, 500000, pool), 5000);
});

test('sclkToEt: piecewise-linear interpolation on either side of the rate change', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  closeTo(sclkToEt(SC, 250000, pool), 2500); // before the breakpoint: rate=1, tikmsc=100 -> 1 tick = 0.01s
  closeTo(sclkToEt(SC, 600000, pool), 5000 + (2 / 100) * 100000); // after: rate=2
});

test('etToSclk is the exact continuous inverse of sclkToEt', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  for (const ticks of [0, 12345, 500000, 750000, 9999999]) {
    const et = sclkToEt(SC, ticks, pool);
    closeTo(etToSclk(SC, et, pool), ticks, 1e-6);
  }
});

test('etToSclkDiscrete rounds to the nearest whole tick', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  const et = sclkToEt(SC, 12345, pool) + 0.001; // nudge off an exact tick
  assert.equal(etToSclkDiscrete(SC, et, pool), 12345);
});

test('sclkToEt throws outside the clock\'s valid tick range', async () => {
  const pool = new KernelPool();
  await loadTestClock(pool);
  assert.throws(() => sclkToEt(SC, -1, pool), /out of range/);
  assert.throws(() => sclkToEt(SC, 20000000, pool), /out of range/); // past the total ticks across both partitions (19,999,999)
});
