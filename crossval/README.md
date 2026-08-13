# Cross-validation against spiceypy

`spiceypy` wraps the real CSPICE library, so it's the closest thing to
ground truth we can check spiceJS against without network access to
naif.jpl.nasa.gov. This directory cross-checks `str2et()`, `spkez()`,
`spkezr()`, `spkState()`, `bodyValues()`, and `prop2b()` against it,
case by case, on a synthetic kernel both sides load identically, plus
several of NAIF's own real, unmodified, publicly distributed kernels
checked in here: `pck00010.tpc`/`pck00011.tpc` (generic text PCK
constants), `gm_de440.tpc` (body GM values), and `dss17.bsp` (a real,
tiny station-position SPK, used to validate segment-type reading and
DAF ID-word handling against genuine binary data, not just synthetic).

## Prerequisites

```sh
pip install spiceypy
```

## Running

```sh
npm run crossval
```

This: (1) generates a synthetic multi-segment `.bsp` (`gen-cases.mjs`,
using `test/helpers/writeSpk.js`) plus a shared `cases.json` describing
every `str2et`/`spkez`/`spkezr`/`prop2b` case to check; (2) runs those
cases through spiceJS (`run-js.mjs`); (3) runs the identical cases
through spiceypy (`run-py.py`); (4) diffs the two result sets
(`compare.mjs`), printing every mismatch beyond tolerance and exiting
non-zero if any exist.

This is **not** part of `npm test` -- it requires Python and
`spiceypy` installed, which the main test suite deliberately doesn't
depend on. Run it after any change to `src/time/`, `src/spk.js`,
`src/pck.js`, `src/daf.js`, `src/bodies.js`, `src/bodyConstants.js`,
`src/frames.js`, `src/bodyOrientation.js`, `src/kernels.js`,
`src/prop2b.js`, `src/math/stumpff.js`, `src/math/eulerFrame.js`,
`src/math/interpolatedRecord.js`, `src/math/lagrangeHermite.js`,
`src/data/*.js`, or the underlying byte-format understanding in
`test/helpers/writeSpk.js`/`test/helpers/writePck.js`.

## Notes on what this does and doesn't cover

- `ref` is exercised against several of the 21 built-in inertial
  frames (`J2000`, `ECLIPJ2000`, `B1950`, `GALACTIC`, `FK4`) and several
  of the built-in body-fixed frames (`IAU_MARS`, `IAU_EARTH`,
  `IAU_MOON`, `IAU_SUN`, driven by the classic formula reading
  `crossval/pck00010.tpc`). FK-defined (frame-kernel) frames and
  binary-PCK-driven orientation aren't covered here -- those were
  instead validated manually against real NAIF-distributed kernels
  (a lunar frame kernel + binary PCK) and spiceypy loading the *same*
  files, cross-checking full 6x6 state transforms (`sxform`), not just
  `spkez`; see the body-fixed-frames round's commit message for the
  specific numbers.
- `spkezr` cases use a mix of real NAIF body-name aliases (case,
  underscore vs. space, plain-integer) for the bodies the synthetic
  kernel has segments for, so name resolution (`src/bodies.js`) is
  exercised against spiceypy's own `spkezr`, not just `spkez`.
- A real fixed-format DAF requires every record, including the last,
  to be a full 1024 bytes -- `test/helpers/writeSpk.js` learned this
  the hard way (cross-validating against a real kernel is exactly how
  that bug surfaced: spiceypy rejected a short-padded file deep in
  `SPKR02`/`DAFGDA` with a confusing "beginning address > ending
  address" error). `test/helpers/writePck.js` follows the same layout.
- `compare.mjs` compares position/velocity components against a
  tolerance relative to the *whole vector's* magnitude, not each
  component's own -- rotating a large vector (e.g. ~1e9 km) into a
  frame where one output component happens to land near zero is
  catastrophic cancellation, not imprecision, and comparing that
  component against its own tiny magnitude would flag ordinary
  float64 rounding noise as a mismatch. This is also how two real
  bugs were found and fixed in a previous round: `spkez()`'s stellar
  aberration divided by zero for a target sitting exactly at the
  observer's position, and a non-inertial `ref` frame centered on
  neither the target nor the observer needs its orientation evaluated
  at a light-time-adjusted epoch (NAIF's `spkez.c`) that itself varies
  with `et`, which the original fixed-epoch analytic rotation missed.
- `dss17.bsp`'s target (a DSN station) reaches the SSB through Earth in
  its own native frame (`ITRF93`), then a further Earth-to-SSB hop in
  J2000 in the synthetic kernel -- `spkez()`/`spkezr()` always chain a
  target all the way to the SSB and spiceJS doesn't rotate between
  frames mid-chain, so that specific combination is (correctly)
  rejected. `spkStateCases` compare `spkState()` (a direct, non-
  chaining lookup) against spiceypy's `spkgeo` instead, which is what's
  actually being validated here (the type 8 reader and the `NAIF/DAF`
  routing fix) -- see gen-cases.mjs's comment on `spkStateCases` for
  the full reasoning.
- Real kernels are also what caught two more bugs this round: `furnsh()`
  rejected legitimate SPK/PCK files using the older, generic `NAIF/DAF`
  ID word instead of `DAF/SPK`/`DAF/PCK` (`dss17.bsp` is one such file;
  real CSPICE still loads it, confirmed empirically); and the text-
  kernel tokenizer required whitespace around `=`, which
  `gm_de440.tpc` doesn't always have (`BODY000_GMLIST= (...`).
- `prop2bCases` cross-check `prop2b()` directly against spiceypy's own
  `prop2b`, independent of any SPK/DAF plumbing -- diverse orbit
  regimes (circular, eccentric, near-parabolic, hyperbolic), both
  signs of `dt`, and scales from LEO to heliocentric. The synthetic
  kernel also carries a type 5 segment (states generated by `prop2b`-
  ing a single reference state to each stored epoch, so they
  genuinely lie on one continuous orbit, matching what a real type 5
  segment's writer requires), exercised through `spkez()` the same way
  types 8/9/12/13 are -- direct lookup plus one chained-through-Sun
  case, across the full `abcorr` table.
