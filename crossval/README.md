# Cross-validation against spiceypy

`spiceypy` wraps the real CSPICE library, so it's the closest thing to
ground truth we can check spiceJS against without network access to
naif.jpl.nasa.gov. This directory cross-checks `str2et()` and
`spkez()` against it, case by case, on a synthetic kernel both sides
load identically.

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
every `str2et`/`spkez` case to check; (2) runs those cases through
spiceJS (`run-js.mjs`); (3) runs the identical cases through spiceypy
(`run-py.py`); (4) diffs the two result sets (`compare.mjs`), printing
every mismatch beyond tolerance and exiting non-zero if any exist.

This is **not** part of `npm test` -- it requires Python and
`spiceypy` installed, which the main test suite deliberately doesn't
depend on. Run it after any change to `src/time/`, `src/spk.js`,
`src/daf.js`, or the underlying byte-format understanding in
`test/helpers/writeSpk.js`.

## Notes on what this does and doesn't cover

- Only `frame='J2000'` is requested from spiceypy, matching spiceJS's
  "native segment frame, no rotation" behavior -- meaningful because
  every synthetic segment here uses frame ID 1 (J2000), so there's
  nothing for a rotation to do; this doesn't validate frame
  transforms (spiceJS doesn't implement them yet).
- `spkez` is compared, not `spkezr` -- both take NAIF integer IDs, so
  no body name resolution is exercised (spiceJS doesn't implement that
  yet either).
- A real fixed-format DAF requires every record, including the last,
  to be a full 1024 bytes -- `test/helpers/writeSpk.js` learned this
  the hard way (cross-validating against a real kernel is exactly how
  that bug surfaced: spiceypy rejected a short-padded file deep in
  `SPKR02`/`DAFGDA` with a confusing "beginning address > ending
  address" error).
