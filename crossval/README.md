# Cross-validation against spiceypy

`spiceypy` wraps the real CSPICE library, so it's the closest thing to
ground truth we can check spiceJS against without network access to
naif.jpl.nasa.gov. This directory cross-checks `str2et()`, `spkez()`,
`spkezr()`, `spkState()`, `bodyValues()`, `prop2b()`, `scEncode()`/
`scDecode()`/`sclkToEt()`/`etToSclk()`, and `ckgp()`/`ckgpav()` against
it, case by case, on a synthetic kernel both sides load identically,
plus several of NAIF's own real, unmodified, publicly distributed
kernels checked in here: `pck00010.tpc`/`pck00011.tpc` (generic text
PCK constants), `gm_de440.tpc` (body GM values), and `dss17.bsp` (a
real, tiny station-position SPK, used to validate segment-type reading
and DAF ID-word handling against genuine binary data, not just
synthetic).

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
every case to check; (1b) generates a real CK + SCLK fixture
(`gen-ck-fixture.py`, using spiceypy's own `ckw01`/`ckw02`/`ckw03`
writers -- see "The CK/SCLK fixture is written by real CSPICE, not
spiceJS" below for why that's a separate script); (2) runs those cases
through spiceJS (`run-js.mjs`); (3) runs the identical cases through
spiceypy (`run-py.py`); (4) diffs the two result sets (`compare.mjs`),
printing every mismatch beyond tolerance and exiting non-zero if any
exist.

This is **not** part of `npm test` -- it requires Python and
`spiceypy` installed, which the main test suite deliberately doesn't
depend on. Run it after any change to `src/time/`, `src/spk.js`,
`src/pck.js`, `src/ck.js`, `src/sclk.js`, `src/daf.js`, `src/bodies.js`,
`src/bodyConstants.js`, `src/frames.js`, `src/bodyOrientation.js`,
`src/kernels.js`, `src/kernelBytes.js`, `src/metaKernel.js`,
`src/prop2b.js`, `src/math/stumpff.js`, `src/math/eulerFrame.js`,
`src/math/quaternion.js`, `src/math/interpolatedRecord.js`,
`src/math/lagrangeHermite.js`, `src/data/*.js`, or the underlying
byte-format understanding in `test/helpers/writeSpk.js`/
`test/helpers/writePck.js`/`test/helpers/writeCk.js`.

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

## The CK/SCLK fixture is written by real CSPICE, not spiceJS

Every other binary fixture here (`kernel.bsp`) is built by spiceJS's
own hand-written encoder (`test/helpers/writeSpk.js`), which only
proves the *reader* agrees with spiceypy on bytes spiceJS itself
produced -- a bug shared by the encoder and the decoder could still
pass. `crossval/fixtures/ck.bc` is different: `gen-ck-fixture.py`
builds it with spiceypy's own real `ckw01`/`ckw02`/`ckw03` (backed by
genuine CSPICE), so `ck.js`'s reader is validated against a file it
never wrote a byte of. It also deliberately includes segments with
`>100` records (150/120/230 for types 1/2/3) specifically so the file
carries a real on-disk "directory" (see `ck.js`'s own module doc
comment for why its reader never parses that directory at all, binary-
searching the full time array directly instead) -- this is what
actually proves that simplification produces identical results to a
directory-aware reader on real data, not just an argument that it
should. `crossval/fixtures/sclk.tsc` (a plain `KPL/SCLK` text kernel,
also written by this script) is what both sides' CK calls need to
convert ticks to `et` for frame composition.

Two real bugs were found this way, both silent-wrong-answer bugs no
amount of self-consistent unit testing alone would have caught (each
test's own "expected" value had been hand-derived using the same
mistaken reasoning as the implementation it was checking):

- **`axisAngleToMatrix()`'s row/column convention was backwards.**
  `axisar_`'s Fortran loop writes into contiguous 3-element chunks of a
  flat 9-array; an initial reading assumed those chunks were matrix
  *rows*, giving the *transpose* of the real `axisar_` result. Every
  CK type 2 case (which composes exactly one such matrix) came out
  transposed as a result -- caught immediately once a case used a
  non-trivial rotation angle. Type 3 cases didn't catch it at first
  for a subtler reason: the first round of `ckCases` happened to only
  ever request a `sclkdp` landing exactly on a recorded instance
  (`frac=0` or `1`), which never exercises the interpolation math at
  all -- fixed by adding a case squarely between two recorded
  instances (`frac=0.5`) once the type 2 failure raised the question
  of whether type 3's own `axisar_`/`raxisa_` usage was affected too
  (it was, and the same fix corrected it).
- **SCLK pool variable names use the spacecraft ID's *absolute value*,
  not the signed ID `scEncode()`/`sct2e()`/etc. themselves take.**
  E.g. `SCLK_DATA_TYPE_900`, never `SCLK_DATA_TYPE_-900`, for
  spacecraft `-900` -- confirmed directly (a kernel with the signed
  variable name failed to load for real CSPICE too, with a
  `SPICE(KERNELVARNOTFOUND)` naming the *unsigned* variable). This is
  the opposite convention from `CK_<inst>_SCLK` (used by `ckmeta_`'s
  own instrument-to-clock lookup), which *does* use the signed
  instrument ID -- also confirmed directly, not assumed from the first
  variable family's own pattern.
