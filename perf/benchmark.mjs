#!/usr/bin/env node
/**
 * Demonstrates lazy-loading's real network-cost reduction and
 * ephemeris accuracy, against the real, unmodified de440.bsp -- the
 * exact kernel docs/lazy-loading.md's design was scoped around.
 *
 * For each (body, time range) test case, this runs an *isolated*
 * `openRemoteSpk()` + `prefetch()` (a fresh RemoteFile, no cache --
 * the cost of exactly this one query in isolation, not amortized
 * across the others) against the real file over the network, records
 * how many HTTP requests and bytes that took, and evaluates ordinary
 * `spkez()` at a handful of sample epochs across the range. Results
 * are written to `results/lazy-results.json` for `spiceypy-
 * reference.py` (real CSPICE ground truth) and `report.mjs`
 * (comparison + a formatted summary) to pick up.
 *
 * Requires network access to naif.jpl.nasa.gov. Downloads the real
 * de440.bsp (~114 MB) once, cached locally in fixtures/, purely so
 * spiceypy-reference.py has a local copy to furnsh() -- the lazy
 * loader itself never reads that local copy; every byte it uses comes
 * from its own network fetches, counted here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRemoteSpk } from '../src/lazy/openRemoteSpk.js';
import { spkez, spkSegments } from '../src/spk.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
const resultsDir = path.join(here, 'results');
fs.mkdirSync(fixturesDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

const DE440_URL = 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440.bsp';
const DE440_LOCAL = path.join(fixturesDir, 'de440.bsp');

if (!fs.existsSync(DE440_LOCAL)) {
  console.log('Downloading de440.bsp (~114 MB, one-time -- for spiceypy\'s ground-truth reference only)...');
  const res = await fetch(DE440_URL);
  if (!res.ok) throw new Error(`de440.bsp download failed: HTTP ${res.status}`);
  fs.writeFileSync(DE440_LOCAL, Buffer.from(await res.arrayBuffer()));
  console.log(`Saved to ${DE440_LOCAL} (${fs.statSync(DE440_LOCAL).size} bytes).\n`);
}

const BODIES = [
  { name: 'Earth', target: 399 },
  { name: 'Moon', target: 301 },
  { name: 'Jupiter (barycenter)', target: 5 },
  { name: 'Neptune (barycenter)', target: 8 },
];
const OBSERVER = 0; // Solar System Barycenter

const J2000 = 0; // reference epoch: 2000-01-01T12:00:00 TDB
const DAY = 86400;
const YEAR = 365.25 * DAY; // Julian year
const FIXED_RANGES = [
  { name: '1 day', duration: DAY },
  { name: '1 month', duration: 30 * DAY },
  { name: '1 year', duration: YEAR },
  { name: '10 years', duration: 10 * YEAR },
];
const SAMPLE_COUNT = 5;

function sampleEpochs(etStart, etEnd, count) {
  if (etStart === etEnd) return [etStart];
  return Array.from({ length: count }, (_, i) => etStart + (i / (count - 1)) * (etEnd - etStart));
}

/**
 * The (target, observer) pair's own actual coverage in this file --
 * discovered from the file's real segment descriptors (the
 * intersection of every hop's own startEt/stopEt), not hardcoded,
 * for the "full de440 range" case.
 */
async function discoverFullRange(target, observer) {
  const probe = await openRemoteSpk(DE440_URL);
  await probe.prefetch({ target, observer, etStart: J2000, etEnd: J2000 });
  const segments = spkSegments(probe.pool);
  return {
    etStart: Math.max(...segments.map((s) => s.startEt)),
    etEnd: Math.min(...segments.map((s) => s.stopEt)),
  };
}

function fmtBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

const cases = [];

for (const body of BODIES) {
  const fullRange = await discoverFullRange(body.target, OBSERVER);
  const ranges = [
    ...FIXED_RANGES.map((r) => ({ name: r.name, etStart: J2000, etEnd: J2000 + r.duration })),
    { name: 'full de440 range', etStart: fullRange.etStart, etEnd: fullRange.etEnd },
  ];

  for (const range of ranges) {
    let requestCount = 0;
    let requestBytes = 0;
    const resolveRange = async (url, startByte, endByteExclusive) => {
      requestCount++;
      requestBytes += endByteExclusive - startByte;
      const res = await fetch(url, { headers: { Range: `bytes=${startByte}-${endByteExclusive - 1}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    };

    // A fresh RemoteFile, no cache: the isolated cost of exactly this
    // one query, as if it were the only thing this app ever asked for.
    const remote = await openRemoteSpk(DE440_URL, { resolveRange });
    const eagerBytes = remote.remoteFile.fileLength;

    const t0 = performance.now();
    await remote.prefetch({ target: body.target, observer: OBSERVER, etStart: range.etStart, etEnd: range.etEnd });
    const prefetchMs = performance.now() - t0;

    const sampleEts = sampleEpochs(range.etStart, range.etEnd, SAMPLE_COUNT);
    const states = sampleEts.map((et) => {
      const { position, velocity } = spkez(body.target, OBSERVER, et, 'NONE', null, remote.pool);
      return { et, position, velocity };
    });

    const reductionPct = (1 - requestBytes / eagerBytes) * 100;
    cases.push({
      body: body.name,
      target: body.target,
      observer: OBSERVER,
      range: range.name,
      etStart: range.etStart,
      etEnd: range.etEnd,
      lazyRequests: requestCount,
      lazyBytes: requestBytes,
      eagerBytes,
      prefetchMs,
      states,
    });

    console.log(
      `${body.name.padEnd(22)} ${range.name.padEnd(18)} ` +
        `${String(requestCount).padStart(2)} reqs  ${fmtBytes(requestBytes).padStart(10)} ` +
        `(${reductionPct.toFixed(2)}% saved vs ${fmtBytes(eagerBytes)})  ${prefetchMs.toFixed(0)} ms`
    );
  }
}

fs.writeFileSync(path.join(resultsDir, 'lazy-results.json'), JSON.stringify(cases, null, 2));
console.log(`\nWrote ${cases.length} cases to results/lazy-results.json`);
