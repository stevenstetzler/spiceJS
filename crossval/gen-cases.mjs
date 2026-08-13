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

// Linear-motion states for the interpolated types (8/9/12/13) --
// exactly reconstructed by Lagrange/Hermite interpolation regardless
// of which states end up in the window (see test/spk.test.js), so
// only agreement with real CSPICE is actually being tested here, same
// reasoning as linearType2/3 above.
function linearStates({ p0, v0, n, ets }) {
  return ets.map((t) => [...p0.map((p, i) => p + v0[i] * t), ...v0]);
}

function interpolatedSegment({ target, center, type, p0, v0, ets, degree }) {
  return {
    target,
    center,
    frame: 1,
    type,
    startEt: ets[0],
    stopEt: ets[ets.length - 1],
    ...(type === 8 || type === 12
      ? { begin: ets[0], step: ets[1] - ets[0] }
      : { epochs: ets }),
    degree,
    states: linearStates({ p0, v0, ets }),
  };
}

const EQUAL_STEP_ETS = Array.from({ length: 8 }, (_, i) => -RADIUS + (i * (2 * RADIUS)) / 7);
const UNEQUAL_STEP_ETS = [-RADIUS, -0.6 * RADIUS, -0.1 * RADIUS, 0.05 * RADIUS, 0.4 * RADIUS, 0.7 * RADIUS, RADIUS];

// 499 ("Mars") rel. 10 ("Sun"); 10 rel. 0 (SSB, nonzero velocity so
// stellar aberration isn't a degenerate no-op); 399 ("Earth", type 3)
// direct rel. SSB; 301 ("Moon") rel. 399, three hops from the SSB.
// 599/699/799/899 (unused real planet IDs, borrowed as convenient
// distinct target codes) rel. 10, one each of types 8/9/12/13.
const segments = [
  linearType2({ target: 499, center: 10, p0: [2.2e8, 1.5e8, 5e6], v0: [15, -8, 3] }),
  linearType2({ target: 10, center: 0, p0: [0, 0, 0], v0: [0.01, -0.005, 0.002] }),
  linearType3({ target: 399, center: 0, p0: [1.47e8, 0, 0], v0: [0, 29.8, 0] }),
  linearType2({ target: 301, center: 399, p0: [3.8e5, 0, 0], v0: [0, 1.0, 0.1] }),
  interpolatedSegment({
    target: 599,
    center: 10,
    type: 8,
    p0: [7.8e8, -3.2e8, 1.2e7],
    v0: [-13, -12, 0.2],
    ets: EQUAL_STEP_ETS,
    degree: 3,
  }),
  interpolatedSegment({
    target: 699,
    center: 10,
    type: 9,
    p0: [1.4e9, 2.0e8, -4.5e7],
    v0: [-3, 9, -0.1],
    ets: UNEQUAL_STEP_ETS,
    degree: 3,
  }),
  interpolatedSegment({
    target: 799,
    center: 10,
    type: 12,
    p0: [2.9e9, -6.0e8, 2.0e7],
    v0: [1.4, 6.5, -0.05],
    ets: EQUAL_STEP_ETS,
    degree: 3,
  }),
  interpolatedSegment({
    target: 899,
    center: 10,
    type: 13,
    p0: [4.5e9, 1.0e9, -1.0e8],
    v0: [-0.5, 5.4, 0.03],
    ets: UNEQUAL_STEP_ETS,
    degree: 3,
  }),
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

// Types 8/9 (Lagrange) and 12/13 (Hermite) -- direct lookups (abcorr
// variety) plus one chained-through-10 case each, proving the
// interpolated types work inside spkez's full pipeline (chaining +
// aberration correction), not just via a bare evaluateSegment() call.
for (const et of ets) {
  for (const abcorr of abcorrs) {
    spkezCases.push({ target: 599, center: 10, et, abcorr }); // type 8
    spkezCases.push({ target: 699, center: 10, et, abcorr }); // type 9
    spkezCases.push({ target: 799, center: 10, et, abcorr }); // type 12
    spkezCases.push({ target: 899, center: 10, et, abcorr }); // type 13
  }
  spkezCases.push({ target: 599, center: 0, et, abcorr: 'LT+S' }); // chained via 10
  spkezCases.push({ target: 899, center: 0, et, abcorr: 'CN+S' });
}

// ref: rotate into a handful of the 21 built-in inertial frames --
// this is what actually proves the extracted rotation matrices and
// their composition order (see scripts/extract-inertial-frames.mjs)
// are correct, not just self-consistent.
const refFrames = ['J2000', 'ECLIPJ2000', 'B1950', 'GALACTIC', 'FK4'];
for (const et of ets) {
  for (const ref of refFrames) {
    spkezCases.push({ target: 499, center: 10, et, abcorr: 'NONE', ref });
    spkezCases.push({ target: 499, center: 0, et, abcorr: 'LT+S', ref }); // chained + corrected + rotated
    spkezCases.push({ target: 301, center: 0, et, abcorr: 'CN+S', ref });
  }
}

// ref: the built-in body-fixed (IAU_*) frames, driven by the classic
// text-PCK orientation formula in crossval/pck00010.tpc (both sides
// furnsh this same real NAIF-distributed kernel -- see run-js.mjs/
// run-py.py) -- proves bodyOrientation.js's RA/DEC/W polynomial +
// periodic-term formula and frames.js's TIPM/DTIPM construction, not
// just the fixed-matrix inertial frames above.
const bodyFixedRefFrames = ['IAU_MARS', 'IAU_EARTH', 'IAU_MOON', 'IAU_SUN'];
for (const et of ets) {
  for (const ref of bodyFixedRefFrames) {
    spkezCases.push({ target: 499, center: 10, et, abcorr: 'NONE', ref });
    spkezCases.push({ target: 301, center: 399, et, abcorr: 'LT+S', ref });
  }
}

// spkezr: body name strings (a mix of aliases -- case, underscore vs.
// space, plain-integer -- for the bodies the synthetic kernel above
// actually has segments for), cross-checked against spiceypy's own
// spkezr (not spkez), so name resolution is exercised end to end.
const spkezrCases = [];
for (const et of [0, 2500000]) {
  for (const abcorr of ['NONE', 'LT+S']) {
    for (const ref of ['J2000', 'ECLIPJ2000']) {
      spkezrCases.push({ target: 'MARS', observer: 'SSB', et, abcorr, ref });
      spkezrCases.push({ target: 'mars', observer: 'Solar System Barycenter', et, abcorr, ref });
      spkezrCases.push({ target: 'Earth', observer: '0', et, abcorr, ref });
      spkezrCases.push({ target: 'MOON', observer: 'earth', et, abcorr, ref });
      spkezrCases.push({ target: 'sun', observer: 'SOLAR_SYSTEM_BARYCENTER', et, abcorr, ref });
    }
  }
}
spkezrCases.push({ target: 'NOT_A_REAL_BODY', observer: '0', et: 0, abcorr: 'NONE', ref: 'J2000' });

// dss17.bsp: a real, NAIF-distributed SPK (station position), type 8,
// using the generic "NAIF/DAF" ID word -- both sides furnsh it too
// (see run-js.mjs/run-py.py). Its target (399017) reaches the SSB
// through Earth (399) in its own native frame ITRF93, then a further
// hop from Earth to the SSB in J2000 -- spkez()/spkezr() always
// chains a target all the way to the SSB, and spiceJS doesn't support
// rotating between frames mid-chain, so those (correctly) reject this
// specific body combination. Real CSPICE's own spkgeo_ instead finds
// the shortest path (here, the single direct segment, since the
// requested "observer" *is* the target's segment-native center) --
// spkState() is spiceJS's equivalent direct, non-chaining lookup, so
// that's what's compared here (against spiceypy's spkgeo), which is
// exactly what's actually being validated: the type 8 reader and the
// NAIF/DAF routing fix, against real data instead of only synthetic.
const spkStateCases = [
  { target: 399017, center: 399, et: 0, ref: 'ITRF93' },
  { target: 399017, center: 399, et: 500000000, ref: 'ITRF93' },
];

// bodyValues: real BODY#_RADII/_GM constants from NAIF's own
// pck00011.tpc/gm_de440.tpc (both sides furnsh them -- see run-js.mjs/
// run-py.py), cross-checked against spiceypy's bodvrd.
const bodyValueCases = [
  { body: 399, item: 'RADII' },
  { body: 'EARTH', item: 'RADII' },
  { body: 301, item: 'RADII' },
  { body: 499, item: 'RADII' },
  { body: 399, item: 'GM' },
  { body: 'MARS BARYCENTER', item: 'GM' },
  { body: 10, item: 'GM' },
  { body: 399, item: 'NOT_A_REAL_ITEM' },
];

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
  JSON.stringify({ str2etCases, spkezCases, spkezrCases, spkStateCases, bodyValueCases }, null, 2)
);

console.log(`Wrote kernel.bsp (${segments.length} segments) and cases.json ` +
  `(${str2etCases.length} str2et cases, ${spkezCases.length} spkez cases, ${spkezrCases.length} spkezr cases, ` +
  `${spkStateCases.length} spkState cases, ${bodyValueCases.length} bodyValues cases).`);
