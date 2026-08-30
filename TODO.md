# TODO

Things discussed or scoped but not implemented yet. Everything here
fails today with a clear, catchable error — never a silently wrong
answer — unless noted otherwise.

## Core library

- **CK data types 4, 5, and 6.** Types 1, 2, and 3 (`src/ck.js`) cover
  essentially every real mission CK product — type 3 (linear
  interpolation) is by far the most common, with 1 (discrete) and 2
  (fixed angular rate) real but less so. Type 4 (Chebyshev polynomials,
  ESOC-style products), 5 (unequal-interval Hermite/Lagrange, the CK
  counterpart of SPK's own 9/13), and 6 (ESOC/quaternion Hermite) are
  real but rarer, following the same phased-rollout precedent SPK's
  own 8/9/12/13/21 types did after 2/3/5 shipped first.
- **SCLK data type 2**, and time system 2 (TDT) within type 1
  (`src/sclk.js`) — type 1 is the only SCLK data type NAIF has ever
  actually shipped real kernels for, and within it, time system 1
  (TDB) is by far the common real case; a kernel claiming either is a
  clear error rather than silently mishandled. TDT support specifically
  needs a TDT&lt;-&gt;TDB conversion this library doesn't have yet (the
  existing `UTC<->TDB` path is leapseconds-based and unrelated).
- **DSK (digital shape) kernels.** A different container format
  entirely (DAS, not DAF) — real new groundwork, not an extension of
  the existing DAF reader.
- **Dynamic and switch reference frames**, and the one built-in class
  4 frame in NAIF's table (`EARTH_FIXED`, a hardcoded ITRF93-relative
  frame, not PCK-driven). Only the fixed-matrix inertial frames,
  PCK-driven body-fixed frames, and FK-defined (TK/PCK-backed) frames
  are supported today.
- **Orientation constants defined relative to a non-J2000 epoch or
  frame** (`BODY#_CONSTANTS_JED_EPOCH`/`BODY#_CONSTANTS_REF_FRAME`).
  Rare in practice; a loaded kernel that sets either is a clear error
  rather than being silently ignored.
- **General time zones** beyond the handful `str2et_c` itself
  documents (the U.S. zones, and `UTC±H:MM`).
- **Lazy-loading Phase 4**: SPK/PCK segment types 5/9/13/21 with a
  large epoch/record count (`N`) use an on-disk directory (one entry
  per 100) in the real format specifically so a reader can
  binary-search it instead of reading the whole epoch array.
  `readUnequalStepEpochs()` currently always reads the full array and
  explicitly skips the directory — fine for the small/medium-`N`
  kernels tested so far, but not optimal for a very-high-cadence
  kernel (hundreds of thousands of epochs/records or more). Needs a
  source-verification pass against `spkr09.c`/`spkr05.c`/`spkr21.c` in
  the OpenSpace/Spice mirror before it can be scoped precisely — see
  `docs/lazy-loading.md`'s "Phase 4" section.
- **Partial/range-based caching for `load()`'s own cache layer.**
  `createMemoryCache()`/`createIndexedDbCache()` (`src/cache.js`) are a
  plain key(URL)/whole-value store — a cache miss re-downloads the
  entire file, even if `openRemoteSpk()`/`openRemotePck()`'s own
  separate block-aligned range cache (`docs/browser-support.md` §3.6,
  now implemented) already has some of those same bytes. Unifying the
  two into one range-aware cache is a documented future direction, not
  attempted.

Visualization/example-app gaps used to live here too, before the
example site and demo split out into its own repo,
[orbit-viewer](https://github.com/stevenstetzler/orbit-viewer) — see
that repo's own `TODO.md`.
