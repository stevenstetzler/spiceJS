import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteFile, openRemoteFile } from '../../src/lazy/remoteFile.js';
import { createMemoryCache } from '../../src/cache.js';

// A fake remote source: a real in-memory "file" (so fetched bytes are
// checkable byte-for-byte), logging every range request it receives.
function fakeSource(fileLength) {
  const wholeFile = new Uint8Array(fileLength);
  for (let i = 0; i < fileLength; i++) wholeFile[i] = i % 256; // deterministic, checkable content
  const requests = [];
  const resolveRange = async (url, startByte, endByteExclusive) => {
    requests.push([startByte, endByteExclusive]);
    return wholeFile.slice(startByte, endByteExclusive);
  };
  return { wholeFile, requests, resolveRange };
}

test('ensureRange fetches exactly the requested bytes and populates the buffer correctly', async () => {
  const { wholeFile, resolveRange } = fakeSource(1000);
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange });

  await remote.ensureRange(150, 250);
  assert.deepEqual(Array.from(remote.buffer.subarray(100, 300)), Array.from(wholeFile.subarray(100, 300)));
  assert.ok(remote.isPopulated(100, 300));
  assert.ok(!remote.isPopulated(0, 100));
  assert.ok(!remote.isPopulated(300, 400));
});

test('ensureRange coalesces adjacent missing blocks into a single request', async () => {
  const { requests, resolveRange } = fakeSource(1000);
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange });

  // Touches blocks 1,2,3 (bytes [150,250) -> block 1; up to byte 349 -> block 3) -- one contiguous run.
  await remote.ensureRange(150, 350);
  assert.deepEqual(requests, [[100, 400]]); // one request covering blocks 1-3's full byte range
});

test('ensureRange never re-fetches an already-populated block', async () => {
  const { requests, resolveRange } = fakeSource(1000);
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange });

  await remote.ensureRange(0, 100);
  await remote.ensureRange(50, 150); // overlaps block 0 (already populated) and block 1 (new)
  assert.deepEqual(requests, [
    [0, 100],
    [100, 200],
  ]);
});

test('ensureRange with a non-contiguous request across an already-populated gap issues two requests', async () => {
  const { requests, resolveRange } = fakeSource(1000);
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange });

  await remote.ensureRange(100, 200); // block 1
  await remote.ensureRange(0, 300); // blocks 0,1,2 -- 1 is already there, 0 and 2 are not, and aren't adjacent to each other
  assert.deepEqual(requests, [
    [100, 200],
    [0, 100],
    [200, 300],
  ]);
});

test('ensureRange rejects a range outside the file\'s extent', async () => {
  const { resolveRange } = fakeSource(1000);
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange });
  await assert.rejects(() => remote.ensureRange(900, 1100), /outside .* extent/);
});

test('a zero-length range is a no-op', async () => {
  const { requests, resolveRange } = fakeSource(1000);
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange });
  await remote.ensureRange(50, 50);
  assert.deepEqual(requests, []);
});

test('a populated buffer\'s .checkRange lets reads through silently; an unpopulated range throws', async () => {
  const { resolveRange } = fakeSource(1000);
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange });
  await remote.ensureRange(0, 100);

  assert.doesNotThrow(() => remote.buffer.checkRange(10, 50));
  assert.throws(() => remote.buffer.checkRange(150, 200), /was not prefetched/);
});

test('ensureRange checks the cache before the network, and populates it on a miss', async () => {
  const { wholeFile, requests, resolveRange } = fakeSource(1000);
  const cache = createMemoryCache();
  const remote = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange, cache });

  await remote.ensureRange(0, 100); // miss -- fetched, and cached
  assert.deepEqual(requests, [[0, 100]]);
  const cached = await cache.get('fake://file#block=0');
  assert.ok(cached instanceof Uint8Array);
  assert.deepEqual(Array.from(cached), Array.from(wholeFile.subarray(0, 100)));

  // A second RemoteFile sharing the same cache should serve block 0 from cache, not the network.
  const remote2 = new RemoteFile('fake://file', 1000, { blockBytes: 100, resolveRange, cache });
  await remote2.ensureRange(0, 100);
  assert.deepEqual(requests, [[0, 100]]); // unchanged -- no second network request
  assert.deepEqual(Array.from(remote2.buffer.subarray(0, 100)), Array.from(wholeFile.subarray(0, 100)));
});

test('openRemoteFile learns fileLength via a HEAD-shaped getFileLength by default', async () => {
  const { resolveRange } = fakeSource(12345);
  let headCalled = false;
  const getFileLength = async (url) => {
    headCalled = true;
    assert.equal(url, 'fake://file');
    return 12345;
  };
  const remote = await openRemoteFile('fake://file', { getFileLength, resolveRange });
  assert.equal(headCalled, true);
  assert.equal(remote.fileLength, 12345);
  assert.equal(remote.buffer.byteLength, 12345);
});

test('openRemoteFile skips getFileLength entirely when fileLength is passed explicitly', async () => {
  const { resolveRange } = fakeSource(500);
  let getFileLengthCalled = false;
  const remote = await openRemoteFile('fake://file', {
    fileLength: 500,
    resolveRange,
    getFileLength: async () => {
      getFileLengthCalled = true;
      return 500;
    },
  });
  assert.equal(getFileLengthCalled, false);
  assert.equal(remote.fileLength, 500);
});
