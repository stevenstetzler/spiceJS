// Builds the shared fixtures for the spiceypy cross-validation:
//   crossval/fixtures/kernel.bsp  -- a synthetic multi-segment SPK
//   crossval/fixtures/cases.json  -- every str2et/spkez case to check
//
// Both run-js.mjs and run-py.py read these same two files, so a
// mismatch in results can only come from spiceJS vs. spiceypy
// disagreeing on the *math*, not from the two sides testing different
// inputs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSpk } from '../test/helpers/writeSpk.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });

const RADIUS = 5.0e7; // ~1.6 years either side of the segment midpoint (et=0)

// Linear-motion segments (see test/spk.test.js for why: exactly
// representable by a degree-1 Chebyshev fit, so spiceJS's own
// correctness isn't in question here -- only agreement with real
// CSPICE is). Position (km) and velocity (km/s) are realistic orbital
// scales so light-time/stellar-aberration corrections are meaningful,
// not degenerate zeros.
function linearType2({ target, center, p0, v0 }) {
  return {
    target,
    center,
    frame: 1,
    type: 2,
    startEt: -RADIUS,
    stopEt: RADIUS,
    init: -RADIUS,
    intlen: 2 * RADIUS,
    records: [{ mid: 0, radius: RADIUS, coeffsByAxis: p0.map((p, i) => [p, v0[i] * RADIUS]) }],
  };
}

function linearType3({ target, center, p0, v0 }) {
  const posCoeffs = p0.map((p, i) => [p, v0[i] * RADIUS]);
  const velCoeffs = v0.map((v) => [v, 0]);
  return {
    target,
    center,
    frame: 1,
    type: 3,
    startEt: -RADIUS,
    stopEt: RADIUS,
    init: -RADIUS,
    intlen: 2 * RADIUS,
    records: [{ mid: 0, radius: RADIUS, coeffsByAxis: [...posCoeffs, ...velCoeffs] }],
  };
}

// 499 ("Mars") rel. 10 ("Sun"); 10 rel. 0 (SSB, nonzero velocity so
// stellar aberration isn't a degenerate no-op); 399 ("Earth", type 3)
// direct rel. SSB; 301 ("Moon") rel. 399, three hops from the SSB.
const segments = [
  linearType2({ target: 499, center: 10, p0: [2.2e8, 1.5e8, 5e6], v0: [15, -8, 3] }),
  linearType2({ target: 10, center: 0, p0: [0, 0, 0], v0: [0.01, -0.005, 0.002] }),
  linearType3({ target: 399, center: 0, p0: [1.47e8, 0, 0], v0: [0, 29.8, 0] }),
  linearType2({ target: 301, center: 399, p0: [3.8e5, 0, 0], v0: [0, 1.0, 0.1] }),
];

fs.writeFileSync(path.join(fixturesDir, 'kernel.bsp'), writeSpk({ segments }));

const abcorrs = ['NONE', 'LT', 'LT+S', 'CN', 'CN+S', 'XLT', 'XLT+S', 'XCN', 'XCN+S'];
const ets = [-3.0e7, -1.0e6, 0, 2500000, 4.9e7];

const spkezCases = [];
for (const et of ets) {
  for (const abcorr of abcorrs) {
    spkezCases.push({ target: 499, center: 10, et, abcorr }); // direct segment
    spkezCases.push({ target: 499, center: 0, et, abcorr }); // one hop (via 10)
    spkezCases.push({ target: 301, center: 0, et, abcorr }); // two hops (via 399)
    spkezCases.push({ target: 301, center: 10, et, abcorr }); // three hops, shared root only
  }
}
// Self state and a Type-3-only lookup, NONE correction is enough to prove those paths.
spkezCases.push({ target: 399, center: 399, et: 0, abcorr: 'NONE' });
spkezCases.push({ target: 399, center: 0, et: 1.0e6, abcorr: 'NONE' });

const str2etCases = [
  '2000-01-01T12:00:00',
  '2000-01-01T12:00:00 TDB',
  '2000-01-01T12:00:00 TDT',
  '2026-08-11T06:30:45.250',
  '1998-12-31T23:59:59',
  '1999-01-01T00:00:00',
  '2026 AUG 11 12:00:00',
  '11 AUG 2026 12:00:00',
  'AUG 11, 2026 12:00:00',
  '17JUN1982 18:28:28',
  "'93 Jan 23 12:29:47.289",
  '23 A.D. APR 4, 18:28:29.29',
  '18 B.C. Jun 3, 12:29:28.291',
  '2/3/1996 17:18:12.002',
  '1997-162::12:18:28.827',
  'JD 2451545.0',
  '2451545.0 JD',
  '1972-01-01T00:00:00',
  '2017-01-01T00:00:00',
  '2026-08-11T12:00:00 UTC',
];

fs.writeFileSync(
  path.join(fixturesDir, 'cases.json'),
  JSON.stringify({ str2etCases, spkezCases }, null, 2)
);

console.log(`Wrote kernel.bsp (${segments.length} segments) and cases.json ` +
  `(${str2etCases.length} str2et cases, ${spkezCases.length} spkez cases).`);
