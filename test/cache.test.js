import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache, createIndexedDbCache } from '../src/cache.js';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';

test('createMemoryCache: get on a missing key returns null', async () => {
  const cache = createMemoryCache();
  assert.equal(await cache.get('missing'), null);
});

test('createMemoryCache: put then get round-trips the exact bytes', async () => {
  const cache = createMemoryCache();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await cache.put('key', bytes);
  assert.equal(await cache.get('key'), bytes); // same reference -- no copy, no serialization
});

test('createMemoryCache: separate instances do not share state', async () => {
  const a = createMemoryCache();
  const b = createMemoryCache();
  await a.put('key', new Uint8Array([1]));
  assert.equal(await b.get('key'), null);
});

// This has to run before anything below installs a global `indexedDB`
// polyfill, and node:test runs a file's tests sequentially in
// declaration order by default -- see the second test for the polyfill
// setup/teardown.
test('createIndexedDbCache throws a clear error when indexedDB is unavailable', () => {
  assert.equal(typeof globalThis.indexedDB, 'undefined');
  assert.throws(() => createIndexedDbCache(), /indexedDB is not available/);
});

test('createIndexedDbCache: put/get round-trips bytes and a miss returns null, once a polyfill supplies indexedDB', async () => {
  globalThis.indexedDB = fakeIndexedDB;
  try {
    const cache = createIndexedDbCache({ dbName: `spicejs-test-${Math.random().toString(36).slice(2)}` });

    assert.equal(await cache.get('missing'), null);

    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    await cache.put('key', bytes);
    const roundtripped = await cache.get('key');
    assert.ok(roundtripped instanceof Uint8Array);
    assert.deepEqual(Array.from(roundtripped), Array.from(bytes));

    // A second key doesn't disturb the first.
    await cache.put('other', new Uint8Array([9]));
    assert.deepEqual(Array.from(await cache.get('key')), Array.from(bytes));
  } finally {
    delete globalThis.indexedDB;
  }
});

test('createIndexedDbCache: two caches with different dbName do not share entries', async () => {
  globalThis.indexedDB = fakeIndexedDB;
  try {
    const suffix = Math.random().toString(36).slice(2);
    const cacheA = createIndexedDbCache({ dbName: `spicejs-test-a-${suffix}` });
    const cacheB = createIndexedDbCache({ dbName: `spicejs-test-b-${suffix}` });

    await cacheA.put('key', new Uint8Array([1, 2, 3]));
    assert.equal(await cacheB.get('key'), null);
  } finally {
    delete globalThis.indexedDB;
  }
});
