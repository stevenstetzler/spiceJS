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
import { prop2b } from '../src/prop2b.js';

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

// Type 5 (two-body propagation): a handful of states sampled along a
// genuinely eccentric orbit (not the circular-orbit trick
// test/spk.test.js uses -- that's an independent, closed-form referee
// for spiceJS's *own* correctness, but here only agreement with real
// CSPICE is being tested, so any physically-consistent orbit works).
// Each state is `prop2b`'d from a single reference state at t=0, so
// they all genuinely lie on one continuous two-body orbit -- exactly
// what a real type 5 segment's writer (spkw05_) requires.
function type5Segment({ target, center, gm, pvinit, ets }) {
  return {
    target,
    center,
    frame: 1,
    type: 5,
    startEt: ets[0],
    stopEt: ets[ets.length - 1],
    gm,
    epochs: ets,
    states: ets.map((t) => prop2b(gm, pvinit, t)),
  };
}

// Type 21 (extended difference lines): two records, each an
// independently-verified closed-form arc (see test/spk.test.js's own
// type 21 tests for the full derivation from spke21.c's literal
// recurrence) -- record 0 constant acceleration, record 1 constant
// jerk (so the recurrence loop itself, not just its degenerate
// zero-iteration case, is exercised here too). This is real CSPICE's
// own *reader* (spkr21_/spke21_) being cross-checked against
// spiceJS's -- spiceypy has no type 21 *writer* to compare against
// (`spkw21` isn't wrapped), so spiceJS's own encoder
// (test/helpers/writeSpk.js) is the only way to produce these bytes,
// same as every other type here; what's actually being validated is
// whether CSPICE's reader agrees with spiceJS's on the same bytes.
function type21Segment({ target, center, t1, order1, order2 }) {
  // Every record in one type 21 segment shares a single `maxdim`
  // (stored once, in the segment's own trailer -- see
  // interpolatedRecord.js's readDifferenceLine()), so record1's own
  // g/dt are padded out to order2's maxdim=2 even though it never
  // reads the second slot (kqmax1=2 means mq2=0, so g is never read
  // at all, and kq=[1,1,1] means only dt[axis][0] is ever summed).
  //
  // `epochs[i]` is difference line i's own *coverage end time*, not
  // its reference epoch `tl` (confirmed against spkw21.c's own
  // Detailed_Input -- see interpolatedRecord.js's module doc comment)
  // -- record1 (order1) covers everything up to and including t1,
  // record2 (order2) covers from just after t1 through the segment's
  // own stop time (RADIUS).
  const record1 = {
    tl: 0,
    g: [1, 1], // g[1] padding -- never read (mq2=0 for kqmax1=2)
    refPos: order1.refPos,
    refVel: order1.refVel,
    dt: order1.a.map((a) => [a, 0]), // dt[axis][1] padding -- never read (kq=1)
    kqmax1: 2,
    kq: [1, 1, 1],
  };
  // record2 picks up exactly where record1 leaves off at t1 (continuous position/velocity).
  const p1 = order1.refPos.map((p, i) => p + order1.refVel[i] * t1 + 0.5 * order1.a[i] * t1 * t1);
  const v1 = order1.refVel.map((v, i) => v + order1.a[i] * t1);
  const record2 = {
    tl: t1,
    g: [order2.g0, 1],
    refPos: p1,
    refVel: v1,
    dt: order2.a.map((a, i) => [a, order2.jerk[i] * order2.g0]),
    kqmax1: 3,
    kq: [2, 2, 2],
  };
  return {
    target,
    center,
    frame: 1,
    type: 21,
    startEt: -RADIUS,
    stopEt: RADIUS,
    epochs: [t1, RADIUS],
    records: [record1, record2],
  };
}

// 499 ("Mars") rel. 10 ("Sun"); 10 rel. 0 (SSB, nonzero velocity so
// stellar aberration isn't a degenerate no-op); 399 ("Earth", type 3)
// direct rel. SSB; 301 ("Moon") rel. 399, three hops from the SSB.
// 599/699/799/899/999 (unused real planet IDs, borrowed as convenient
// distinct target codes) rel. 10, one each of types 8/9/12/13/5. 199
// ("Mercury", likewise unused) rel. 10, type 21.
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
  type5Segment({
    target: 999,
    center: 10,
    gm: 1.32712440018e11, // GM_SUN (km^3/s^2) -- a real, plausible central-body mass
    pvinit: [1.5e8, 0, 0, 0, 27, 5], // an eccentric heliocentric-scale orbit
    ets: UNEQUAL_STEP_ETS,
  }),
  type21Segment({
    target: 199,
    center: 10,
    t1: 1.0e6, // between ets' -1.0e6 and 2500000 -- record 0 covers the ets below it, record 1 the rest
    order1: {
      refPos: [1.3e8, 4.0e7, 1.0e6],
      refVel: [10, 25, 0.5],
      a: [1.0e-6, -5.0e-7, 2.0e-7], // heliocentric-scale accelerations (~GM_sun/r^2)
    },
    order2: {
      g0: 1,
      // Much smaller than order1's own accelerations: record 2's own
      // domain runs all the way out to RADIUS (~4.8e7s past t1, ~1.5
      // years) since epochs[1] must be >= the segment's own stopEt
      // (spkw21.c's Exception 7 -- see interpolatedRecord.js's module
      // doc comment), and a real ODP-fitted difference line is only
      // ever extrapolated over a few hours to days, not years -- at
      // order1's own scale (~1e-6 km/s^2, ~1e-13 km/s^3) that far an
      // extrapolation produces a wildly unphysical (~100s of km/s)
      // velocity, which in turn amplifies the light-time-correction
      // central difference's truncation error (see spkez()'s own
      // VELOCITY_DERIVATIVE_STEP_S comment) past crossval's tolerance
      // -- a fixture artifact, not a spiceJS bug (confirmed: position,
      // and every abcorr's velocity at the *nearer* et=2500000 case,
      // all matched CSPICE exactly). Scaled down ~40x/~1e4x from the
      // original values so even the RADIUS-distant case stays sane.
      a: [5.0e-8, -7.5e-9, 2.5e-9],
      jerk: [2.0e-15, 1.0e-15, -4.0e-16],
    },
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
    spkezCases.push({ target: 999, center: 10, et, abcorr }); // type 5
    spkezCases.push({ target: 199, center: 10, et, abcorr }); // type 21
  }
  spkezCases.push({ target: 599, center: 0, et, abcorr: 'LT+S' }); // chained via 10
  spkezCases.push({ target: 899, center: 0, et, abcorr: 'CN+S' });
  spkezCases.push({ target: 999, center: 0, et, abcorr: 'LT+S' }); // type 5, chained via 10
  spkezCases.push({ target: 199, center: 0, et, abcorr: 'LT+S' }); // type 21, chained via 10
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

// prop2b: direct crossval against spiceypy.prop2b, independent of any
// SPK/DAF plumbing -- diverse orbit regimes (circular, eccentric,
// near-parabolic, hyperbolic), both signs of dt, and a range of
// physical scales (LEO-ish up to heliocentric).
const prop2bCases = [
  { gm: 398600.4418, pvinit: [7000, 0, 0, 0, 7.5461, 0], dt: 3000 }, // ~circular LEO
  { gm: 398600.4418, pvinit: [8000, 0, 0, 0, 6.5, 3.0], dt: 5000 }, // eccentric
  { gm: 398600.4418, pvinit: [8000, 0, 0, 0, 6.5, 3.0], dt: -12000 }, // eccentric, negative dt
  { gm: 398600.4418, pvinit: [42164, 0, 0, 0, 3.0747, 0], dt: 86400 }, // ~GEO, full day
  { gm: 398600.4418, pvinit: [7000, 1000, -500, 0.5, 7.4, 0.3], dt: 200000 }, // long propagation, non-planar
  { gm: 398600.4418, pvinit: [7000, 0, 0, 0, 10.5, 0], dt: 4000 }, // near-parabolic (fast)
  { gm: 398600.4418, pvinit: [7000, 0, 0, 0, 12.0, 0], dt: 4000 }, // hyperbolic (escape)
  { gm: 398600.4418, pvinit: [7000, 0, 0, 0, 12.0, 0], dt: -4000 }, // hyperbolic, negative dt
  { gm: 1.32712440018e11, pvinit: [1.496e8, 0, 0, 0, 29.78, 0], dt: 3.15576e7 }, // ~1 heliocentric year
  { gm: 1.32712440018e11, pvinit: [1.5e8, 0, 0, 0, 27, 5], dt: -1.0e7 }, // heliocentric, negative dt
  { gm: 398600.4418, pvinit: [7000, 0, 0, 0, 7.5461, 0], dt: 0 }, // dt=0 identity
];

// etToTai/taiToEt round-trip cases -- reuses the same `ets` spread
// spkezCases already exercises (pre-1972, near-J2000, future) plus a
// deep-past epoch, since taiToEt/etToTai need no leap-second table at
// all (unlike utcToEt/etToUtc) and so shouldn't care whether `et`
// predates 1972's first leap second.
const taiCases = [...ets, -2.2e9];

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

// sclkCases/ckCases: driven against SC=-900/INST=-900000, the real,
// CSPICE-authored fixture crossval/gen-ck-fixture.py builds (sclk.tsc
// + ck.bc) -- see that script's own doc comment for why it, not this
// file, owns building that particular fixture. A single partition
// ([0, 2559999999], moduli [10000000, 256]) means no partition-offset
// arithmetic is exercised here -- that's already covered by
// test/sclk.test.js's own dedicated multi-partition synthetic kernel;
// this is purely about spiceJS's *string encoding* and *tick<->et*
// math agreeing with real CSPICE on a real file.
const SC = -900;
const INST = -900000;

const scEncodeCases = [
  '1/0000500:07',
  '0000500:07', // default (omitted) partition
  '2000000:00',
  '0500000:07', // matches the ckCases type1 request below, for a shared sanity point
];
const scDecodeCases = [0, 500, 1281807, 10050006, 20000000, 2559999999];
const sclkToEtCases = [0, 500, 12345, 1281807, 999999999, 2559999999];
const etToSclkCases = [0, 1.953125, 5005.66015625, 9999996.09375];

const ckCases = [];
// Type 1: dense discrete instances, no AV.
for (const sclkdp of [0, 5000, 10000, 745000, 1490000]) {
  ckCases.push({ inst: INST, sclkdp, tol: 1000000, ref: 'J2000', needAv: false });
}
ckCases.push({ inst: INST, sclkdp: 5000, tol: 1000000, ref: 'J2000', needAv: true });
// Type 2: fixed angular rate, mid-interval and at a boundary.
ckCases.push({ inst: INST, sclkdp: 2005000, tol: 1, ref: 'J2000', needAv: true });
ckCases.push({ inst: INST, sclkdp: 2000000, tol: 1, ref: 'J2000', needAv: false }); // interval start, exact
// Type 3: direct interpolation (both landing exactly on a recorded
// instance -- frac=0/1, no interpolation math involved -- and squarely
// between two, frac=0.5, which actually exercises axisar_/raxisa_'s
// own convention -- see crossval/README.md's own notes on the real bug
// this specific kind of case caught, that every frac=0/1 case here
// missed by accident), the gap's closer-endpoint fallback (both from
// the left and the right side), and squarely inside the gap past
// tolerance (not found on either side).
ckCases.push({ inst: INST, sclkdp: 5000500, tol: 100, ref: 'J2000', needAv: false });
ckCases.push({ inst: INST, sclkdp: 5000505, tol: 100, ref: 'J2000', needAv: true }); // frac=0.5 between records 50 and 51
ckCases.push({ inst: INST, sclkdp: 5001300, tol: 400, ref: 'J2000', needAv: false }); // closer to 5,000,990
ckCases.push({ inst: INST, sclkdp: 5001700, tol: 400, ref: 'J2000', needAv: false }); // closer to 5,002,000
ckCases.push({ inst: INST, sclkdp: 5001495, tol: 100, ref: 'J2000', needAv: false }); // not found -- squarely in the gap
// Frame composition: same frame (no-op), another fixed inertial frame
// (no SCLK needed), and a real rotating body-fixed frame (needs the
// full ckgpav omega-term math -- see ck.js's own doc comment).
ckCases.push({ inst: INST, sclkdp: 5000500, tol: 100, ref: 'J2000', needAv: true });
ckCases.push({ inst: INST, sclkdp: 5000500, tol: 100, ref: 'ECLIPJ2000', needAv: true });
ckCases.push({ inst: INST, sclkdp: 5000500, tol: 100, ref: 'IAU_EARTH', needAv: true });
ckCases.push({ inst: INST, sclkdp: 5000505, tol: 100, ref: 'IAU_EARTH', needAv: true }); // frac=0.5 *and* a rotating frame at once
ckCases.push({ inst: INST, sclkdp: 745000, tol: 1000000, ref: 'IAU_MARS', needAv: true }); // type 1, rotating frame
ckCases.push({ inst: INST, sclkdp: 2005000, tol: 1, ref: 'IAU_EARTH', needAv: true }); // type 2, rotating frame
// Not found at all (past every segment's own coverage and tolerance).
ckCases.push({ inst: INST, sclkdp: -1000000, tol: 10, ref: 'J2000', needAv: false });

fs.writeFileSync(
  path.join(fixturesDir, 'cases.json'),
  JSON.stringify(
    {
      str2etCases,
      taiCases,
      spkezCases,
      spkezrCases,
      spkStateCases,
      bodyValueCases,
      prop2bCases,
      sc: SC,
      inst: INST,
      scEncodeCases,
      scDecodeCases,
      sclkToEtCases,
      etToSclkCases,
      ckCases,
    },
    null,
    2
  )
);

console.log(`Wrote kernel.bsp (${segments.length} segments) and cases.json ` +
  `(${str2etCases.length} str2et cases, ${spkezCases.length} spkez cases, ${spkezrCases.length} spkezr cases, ` +
  `${spkStateCases.length} spkState cases, ${bodyValueCases.length} bodyValues cases, ` +
  `${prop2bCases.length} prop2b cases, ${scEncodeCases.length + scDecodeCases.length + sclkToEtCases.length + etToSclkCases.length} sclk cases, ` +
  `${ckCases.length} ck cases).`);
