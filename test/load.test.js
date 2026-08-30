import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { load } from '../src/load.js';
import { unload, kclear } from '../src/kernels.js';
import { KernelPool } from '../src/pool.js';
import { spkState, spkSegments } from '../src/spk.js';
import { createMemoryCache } from '../src/cache.js';
import { writeSpk } from './helpers/writeSpk.js';

// A tiny real HTTP server, not a mocked fetch -- load()'s default
// resolver uses the real global fetch() (Node's own, since Node 18),
// and Node's fetch doesn't enforce browser CORS restrictions (that's
// a browser-only layer -- see docs/browser-support.md §2), so this
// exercises the actual network path end to end, the same way
// crossval/ exercises real spiceypy instead of mocking it.
const LSK_TEXT = 'KPL/LSK\nA leapseconds-shaped fixture for load() tests.\n\\begindata\nTEST/VALUE = 42\n';

const spkSegment = {
  target: 499,
  center: 10,
  frame: 1,
  type: 2,
  startEt: -1000,
  stopEt: 1000,
  init: -1000,
  intlen: 2000,
  records: [{ mid: 0, radius: 1000, coeffsByAxis: [[100, 10], [200, 20], [300, 30]] }],
};
const SPK_BYTES = new Uint8Array(writeSpk({ segments: [spkSegment] }));

// Meta-kernel referencing both fixtures via *relative* URLs (resolved
// against the meta-kernel's own URL by load()'s resolveRelativeReference()),
// plus a PATH_SYMBOLS substitution -- same pattern kernels/basic.tm uses
// for furnsh(), exercised here for load()'s URL-based recursion instead.
const META_TEXT =
  'KPL/MK\n\\begindata\n' +
  "   PATH_VALUES     = ( '.' )\n" +
  "   PATH_SYMBOLS    = ( 'HERE' )\n" +
  "   KERNELS_TO_LOAD = ( '$HERE/lsk.tls', 'kernel.bsp' )\n" +
  '\\begintext\n';

let requestCounts;

function reset() {
  requestCounts = new Map();
}

const routes = {
  '/lsk.tls': { body: LSK_TEXT },
  '/kernel.bsp': { body: SPK_BYTES },
  '/meta.tm': { body: META_TEXT },
};

const server = http.createServer((req, res) => {
  requestCounts.set(req.url, (requestCounts.get(req.url) || 0) + 1);
  const route = routes[req.url];
  if (!route) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200);
  res.end(Buffer.from(route.body));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

test('load() fetches and merges a text kernel from a URL', async () => {
  reset();
  const pool = new KernelPool();
  await load(`${baseUrl}/lsk.tls`, pool);
  assert.deepEqual(pool.getValues('TEST/VALUE'), [42]);
});

test('load() fetches and indexes a binary SPK kernel from a URL', async () => {
  reset();
  const pool = new KernelPool();
  await load(`${baseUrl}/kernel.bsp`, pool);
  assert.deepEqual(spkSegments(pool), [{ target: 499, center: 10, frame: 1, type: 2, startEt: -1000, stopEt: 1000 }]);
  const { position, velocity } = spkState(499, 10, 0, pool);
  assert.deepEqual(position, [100, 200, 300]);
  assert.deepEqual(velocity, [0.01, 0.02, 0.03]);
});

test('load() expands a meta-kernel fetched from a URL, resolving relative KERNELS_TO_LOAD entries against it', async () => {
  reset();
  const pool = new KernelPool();
  await load(`${baseUrl}/meta.tm`, pool);
  assert.deepEqual(pool.getValues('TEST/VALUE'), [42]);
  assert.equal(spkSegments(pool).length, 1);
});

test('load() rejects a 404 with a clear error, not a generic fetch failure', async () => {
  reset();
  const pool = new KernelPool();
  await assert.rejects(() => load(`${baseUrl}/does-not-exist`, pool), /HTTP 404/);
});

test('load() accepts a Blob (browser local-file-picker shape), no network involved', async () => {
  reset();
  const pool = new KernelPool();
  const blob = new Blob([LSK_TEXT]);
  await load(blob, pool);
  assert.deepEqual(pool.getValues('TEST/VALUE'), [42]);
  assert.equal(requestCounts.size, 0); // never touched the server
});

test('load() accepts raw ArrayBuffer/Uint8Array bytes directly', async () => {
  reset();
  const poolFromArrayBuffer = new KernelPool();
  await load(SPK_BYTES.buffer, poolFromArrayBuffer); // SPK_BYTES owns its whole (unshared) ArrayBuffer
  assert.equal(spkSegments(poolFromArrayBuffer).length, 1);

  const poolFromUint8Array = new KernelPool();
  await load(SPK_BYTES, poolFromUint8Array);
  assert.equal(spkSegments(poolFromUint8Array).length, 1);
});

test('load() rejects a reference it does not know how to resolve', async () => {
  reset();
  const pool = new KernelPool();
  await assert.rejects(() => load(42, pool), /don't know how to resolve/);
  await assert.rejects(() => load('not-a-url-or-anything-else', pool), /don't know how to resolve/);
});

test('load()\'s default resolver can be overridden entirely via the `resolve` option', async () => {
  reset();
  const pool = new KernelPool();
  const bytesByName = { 'my-custom-ref': new TextEncoder().encode(LSK_TEXT) };
  await load('my-custom-ref', pool, { resolve: (ref) => bytesByName[ref] });
  assert.deepEqual(pool.getValues('TEST/VALUE'), [42]);
});

test('load() with a cache: a repeat load() of the same URL is served from cache, not re-fetched', async () => {
  reset();
  const cache = createMemoryCache();

  const pool1 = new KernelPool();
  await load(`${baseUrl}/lsk.tls`, pool1, { cache });
  assert.equal(requestCounts.get('/lsk.tls'), 1);

  const pool2 = new KernelPool();
  await load(`${baseUrl}/lsk.tls`, pool2, { cache });
  assert.equal(requestCounts.get('/lsk.tls'), 1); // still 1 -- served from cache
  assert.deepEqual(pool2.getValues('TEST/VALUE'), [42]);
});

test('load() populates the cache on a miss so a *different* pool benefits too', async () => {
  reset();
  const cache = createMemoryCache();
  assert.equal(await cache.get(`${baseUrl}/kernel.bsp`), null);

  const pool = new KernelPool();
  await load(`${baseUrl}/kernel.bsp`, pool, { cache });
  const cached = await cache.get(`${baseUrl}/kernel.bsp`);
  assert.ok(cached instanceof Uint8Array);
  assert.equal(cached.byteLength, SPK_BYTES.byteLength);
});

test('a kernel loaded via load() is unloadable via unload(), and forgotten by kclear()', async () => {
  reset();
  const pool = new KernelPool();
  const url = `${baseUrl}/lsk.tls`;
  await load(url, pool);
  assert.equal(pool.has('TEST/VALUE'), true);

  unload(url, pool);
  assert.equal(pool.has('TEST/VALUE'), false);

  await load(url, pool);
  kclear(pool);
  assert.deepEqual(pool.names(), []);
});
