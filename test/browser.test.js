import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as browserEntry from '../src/browser.js';
import * as indexEntry from '../src/index.js';
import { KernelPool } from '../src/pool.js';
import { spkSegments } from '../src/spk.js';
import { writeSpk } from './helpers/writeSpk.js';

// src/browser.js is meant to be importable in a real browser bundle
// (verified separately with esbuild --platform=browser -- see
// docs/browser-support.md), but there's no reason its *logic* can't
// also run and be tested under Node directly, same as any other pure
// module here -- this just proves its own unload()/kclear() (which
// are NOT re-exports of kernels.js's -- see its doc comment) actually
// undo what load() registers.

test('src/browser.js does not export furnsh -- it is not Node-only-safe to expose here', () => {
  assert.equal('furnsh' in browserEntry, false);
});

// Checked against src/index.js's own actual export list, not a
// hand-maintained copy of it -- a hardcoded list here silently drifts
// out of sync every time a new function is exported (this one already
// had, missing everything CK/SCLK/TAI added since it was last touched)
// without ever failing, which defeats the point of the check.
test('src/browser.js exports exactly what src/index.js does, minus furnsh', () => {
  const indexKeys = Object.keys(indexEntry).sort();
  const browserKeys = Object.keys(browserEntry).sort();
  const expectedBrowserKeys = indexKeys.filter((name) => name !== 'furnsh').sort();
  assert.deepEqual(browserKeys, expectedBrowserKeys);
  for (const name of browserKeys) {
    assert.equal(typeof browserEntry[name], name.startsWith('global') ? 'object' : 'function', `expected ${name}`);
  }
});

test("browser.js's unload()/kclear() undo what load() registers, without any local-path resolution", async () => {
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
  const bytes = new Uint8Array(writeSpk({ segments: [spkSegment] }));

  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(Buffer.from(bytes));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/kernel.bsp`;

  try {
    const pool = new KernelPool();
    await browserEntry.load(url, pool);
    assert.equal(spkSegments(pool).length, 1);

    browserEntry.unload(url, pool);
    assert.equal(spkSegments(pool).length, 0);

    await browserEntry.load(url, pool);
    browserEntry.kclear(pool);
    assert.deepEqual(pool.names(), []);
  } finally {
    server.close();
  }
});
