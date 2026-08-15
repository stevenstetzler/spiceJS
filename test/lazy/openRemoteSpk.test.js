import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSpk } from '../helpers/writeSpk.js';
import { spkez } from '../../src/spk.js';
import { openRemoteSpk } from '../../src/lazy/openRemoteSpk.js';
import { multiRecordLinearSegment } from './helpers/multiRecordSegment.js';

function closeTo(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be close to ${b}`);
}

test('openRemoteSpk(): the public entry point, end to end (custom resolveRange, no real network)', async () => {
  const seg = multiRecordLinearSegment({
    target: 499,
    center: 0,
    p0: [2.2e8, 1.5e8, 5e6],
    v0: [15, -8, 3],
    n: 10,
    intlen: 500,
    init: -2500,
  });
  const buf = writeSpk({ segments: [seg] });
  const requests = [];

  const remote = await openRemoteSpk('fake://kernel.bsp', {
    fileLength: buf.byteLength,
    resolveRange: async (url, startByte, endByteExclusive) => {
      requests.push([startByte, endByteExclusive]);
      return buf.subarray(startByte, endByteExclusive);
    },
  });

  await remote.prefetch({ target: 499, observer: 0, etStart: -100, etEnd: 100 });
  assert.ok(requests.length > 0);

  const et = 42;
  const { position, velocity } = spkez(499, 0, et, 'NONE', null, remote.pool);
  const expected = seg.expectedStateAt(et);
  position.forEach((p, i) => closeTo(p, expected.position[i], 1e-6));
  velocity.forEach((v, i) => closeTo(v, expected.velocity[i], 1e-6));
});
