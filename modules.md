# Code structure

A real SPICE implementation, in plain JS, with zero dependencies, all
under `src/`. Runs in Node and the browser.

This library used to be one of three layers in a single repo (the
other two -- a Horizons/CAD caching proxy and a three.js visualization
built on this library -- have since split out into their own repo,
[orbit-viewer](https://github.com/stevenstetzler/orbit-viewer), which
depends on this one; see that repo's own `modules.md`).

## Core library (`src/`)

A from-scratch reimplementation of the NAIF SPICE primitives this
project needs -- kernel loading, time conversion, trajectory/orientation
evaluation, body/frame name resolution -- built directly against NAIF's
own CSPICE source and cross-validated against `spiceypy` (see
`crossval/`), not reverse-engineered from documentation alone. Zero
dependencies, on anything outside Node's/the browser's own built-ins.

**Entry points** (`package.json`'s `main`/`browser`/`exports`):

| File | For | Adds over the other one |
| --- | --- | --- |
| `src/index.js` | Node | `furnsh()`/`unload()`/`kclear()` -- synchronous, `fs`-backed kernel loading |
| `src/browser.js` | Browser (and Node) | Nothing `index.js` doesn't also have -- it's `index.js` *minus* `furnsh()`, so a bundler never pulls in `node:fs`/`node:path` even transitively (see the file's own doc comment) |

Both re-export the same public surface otherwise: `KernelPool`/`globalPool`,
`load()`, `createMemoryCache()`/`createIndexedDbCache()`, `openRemoteSpk()`/
`openRemotePck()`/`openRemoteFile()`, `str2et()`, `et2utc()`/`et2utcCalendar()`,
`et2tai()`/`et2taiCalendar()`, `taiToEt()`/`etToTai()`, `parseTimeString()`,
`spkState()`/`spkSegments()`/`spkez()`/`spkezr()`, `pckSegments()`,
`ckSegments()`/`ckgp()`/`ckgpav()`, `scEncode()`/`scDecode()`/`sclkToEt()`/
`etToSclk()`/`etToSclkDiscrete()`/`scTicksForFields()`/`scPartitions()`,
`bodyCode()`/`bodyName()`, `bodyValues()`, `prop2b()`, `frameId()`.

**Internal layout** -- grouped by what each piece does, not strictly
one-file-per-bullet (some files are small and paired):

- **Kernel pool & loading** -- `pool.js` (the in-memory kernel pool:
  text variables + SPK/PCK/CK segment index), `kernels.js` (`furnsh`/`unload`/
  `kclear`, Node-only), `load.js` (the async, environment-agnostic
  sibling of `furnsh` -- URL/`File`/`Blob`/raw-bytes), `kernelRegistry.js`
  (shared undo-history bookkeeping both of those build on),
  `kernelBytes.js` (magic-word sniffing + pool merge, the part truly
  shared by both), `kernelReference.js` (the shared "is this a URL"
  check), `metaKernel.js` (KPL/MK `PATH_SYMBOLS`/`KERNELS_TO_LOAD`
  parsing), `textKernel.js` (the KPL text-kernel parser LSK/FK/IK/SCLK
  all share), `cache.js` (pluggable whole-file caches for `load()`),
  `bytes.js` (`Buffer`/`ArrayBuffer`/typed-array normalization).
- **Binary container/format readers** -- `daf.js` (the generic DAF
  container SPK/PCK/CK are all built on), `spk.js` (trajectory segments:
  chaining target→observer through the SSB, aberration correction),
  `pck.js` (binary body-orientation segments), `ck.js`
  (spacecraft/instrument-orientation segments -- multi-file priority
  search with tolerance fallthrough, and frame composition via
  `frames.js`'s `frameRotationMatrix()`).
- **Segment math** (decoding a raw DAF segment into a state/orientation
  at a given time) -- `math/chebyshev.js` (Types 2/3), `math/chebyshevRecord.js`
  (the fixed-size-record layout Types 2/3 and PCK Type 2 share),
  `math/interpolatedRecord.js` (Types 5/8/9/12/13/21's shared layout),
  `math/lagrangeHermite.js` (Types 8/9/12/13's interpolation),
  `math/differenceArray.js` (Type 21's modified-divided-difference
  evaluator), `math/vector3.js` (small vector helpers `spk.js` uses),
  `math/quaternion.js` (quaternion↔matrix and axis-angle↔matrix
  conversions CK Types 2/3 need).
- **Two-body propagation** -- `prop2b.js` (NAIF's universal-variables
  propagator, elliptical/parabolic/hyperbolic uniformly), `math/stumpff.js`
  (the Stumpff functions it needs).
- **Time system** -- `str2et.js` (time-string → ET), `et2utc.js` (the
  round-trip inverse), `et2tai.js` (the TAI-timescale sibling of
  `et2utc.js` -- no real `et2tai_c` exists in CSPICE, the equivalent is
  `unitim_c(et, 'ET', 'TAI')` plus your own formatting), `time/
  parseTimeString.js` (the actual string grammar), `time/calendar.js`
  (calendar ↔ continuous-seconds-past-J2000), `time/deltet.js` (ET ↔
  UTC/TDT via a loaded leapseconds kernel, plus ET ↔ TAI -- the latter
  needs no leapseconds kernel at all, just the fixed 32.184s TT-TAI
  offset),
  `sclk.js` (spacecraft clock: clock-string ↔ ticks, ticks ↔ ET, via a
  loaded `KPL/SCLK` text kernel -- what `ck.js`'s pointing lookups are
  indexed by).
- **Bodies & frames** -- `bodies.js` (name ↔ NAIF ID), `bodyConstants.js`
  (`BODY<id>_GM`/`_RADII`/... from a loaded text PCK), `bodyOrientation.js`
  (the classic text-PCK pole/prime-meridian formula), `frames.js`
  (frame name/ID resolution and rotation -- inertial, body-fixed, and
  kernel-defined), `math/eulerFrame.js` (composing axis rotations into
  a matrix), `data/bodyIds.js`/`data/bodyFixedFrames.js`/`data/inertialFrames.js`
  (NAIF's own built-in tables, extracted verbatim from CSPICE source by
  the matching `scripts/extract-*.mjs` script -- never hand-edited).
- **Lazy/remote loading** (the byte-range machinery that lets a
  multi-gigabyte kernel cost kilobytes to use -- see
  `docs/lazy-loading.md`) -- `lazy/remoteFile.js` (a block-aligned,
  population-tracked view of a remote file), `lazy/byteRange.js`
  (segment descriptor + query window → exact bytes needed),
  `lazy/prefetch.js` (the environment-agnostic "discover, find
  segments, ensure range" core), `lazy/pckPrefetch.js` (PCK's
  find/add-segments for that core), `lazy/openRemoteSpk.js`/
  `lazy/openRemotePck.js` (the public `prefetch()`-based entry points).

**Supporting infrastructure** (not shipped as part of the library, but
what keeps it honest):

- `test/` -- unit tests, roughly one file per `src/` module.
- `crossval/` -- generates synthetic kernels and a shared case list,
  runs them through spiceJS *and* `spiceypy`, and diffs the results
  (`npm run crossval`); see `crossval/README.md`.
- `perf/` -- lazy-loading network/accuracy benchmark against a real
  kernel (`npm run perf`); see `perf/README.md`.
- `docs/browser-support.md`, `docs/lazy-loading.md` -- design docs for
  the browser port and the byte-range loading scheme.
- `kernels/` -- the small bundled text kernels (`naif0012.tls`,
  `pck00011.tpc`, `gm_de440.tpc`, `basic.tm`) that `test/`, `crossval/`,
  and the runnable examples in `examples/` all load. No binary
  SPK/PCK/CK kernels are checked in or fetched here -- this library
  reads whatever bytes it's handed. See `kernels/README.md`.
