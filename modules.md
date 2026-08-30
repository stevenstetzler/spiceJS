# Code structure

Three layers, each usable independently of the other two:

1. **[The core library](#1-core-library-src)** (`src/`) -- a real
   SPICE implementation, in plain JS, with zero dependencies. Runs in
   Node and the browser.
2. **[The Horizons/CAD caching and translation layer](#2-horizonscad-caching--translation-layer)**
   (`scripts/horizonsSpk.mjs`, `scripts/closeApproach.mjs`, and part of
   `scripts/serve-example.mjs`) -- turns a typed name/designation, or a
   request for real close-approach events, into a real trajectory SPK
   or dataset a browser can consume. Server-side (Node) only; doesn't
   import the core library at all.
3. **[The visualization layer](#3-visualization-layer-threejs)**
   (`examples/`, `solar-system/`, `close-approach/`) -- renders real
   trajectories and orbit ellipses in the browser with `three.js`.
   Depends on (1) directly (imports `src/browser.js`) and on (2) over
   HTTP (fetches `/horizons/*`, `/close-approach/data`).

Layer 3 is the only one that depends on the others -- it `import`s
layer 1 directly (`src/browser.js`) and calls layer 2 over plain HTTP
(`/horizons/*`, `/close-approach/data`). Layers 1 and 2 don't depend on
each other or on layer 3 at all: layer 1 is a standalone library that
knows nothing about Horizons or three.js, and layer 2 is a standalone
Node proxy that never imports `src/` -- it relays SPK bytes Horizons
already produced, without parsing them itself.

A worked example of all three at once is at the
[bottom of this file](#how-the-three-fit-together-one-request-end-to-end).

## 1. Core library (`src/`)

A from-scratch reimplementation of the NAIF SPICE primitives this
project needs -- kernel loading, time conversion, trajectory/orientation
evaluation, body/frame name resolution -- built directly against NAIF's
own CSPICE source and cross-validated against `spiceypy` (see
`crossval/`), not reverse-engineered from documentation alone. No
dependency on the other two layers, or on anything outside Node's/the
browser's own built-ins.

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
- `kernels/` -- the two bundled text kernels (`naif0012.tls`,
  `pck00011.tpc`, `gm_de440.tpc`) every session loads, plus
  `sources.mjs` (the catalogue of fetchable remote SPKs -- sizes,
  segment types, real coverage, all read off the live files by
  `scripts/inspect-spk.mjs`, not transcribed), plus `cache/` (gitignored
  -- whole downloads from `scripts/download-spk.mjs`, the range-cache's
  own sparse files from `scripts/rangeCache.mjs`, and the Horizons SPK
  cache from layer 2 below). See `kernels/README.md`.

## 2. Horizons/CAD caching & translation layer

Two things a browser can't do on its own, both solved server-side:
neither of JPL's APIs used here (`ssd-api.jpl.nasa.gov`,
`ssd.jpl.nasa.gov`) sends `Access-Control-Allow-Origin`, so a page can
never `fetch()` them directly; and regenerating the same object's SPK
from Horizons on every request would be wasteful when the result
rarely changes. This layer is pure Node, with **no dependency on `src/`
at all** -- it never parses or evaluates SPK bytes itself, just
resolves, fetches, caches, and relays what JPL's own APIs already
produce.

- **`scripts/horizonsSpk.mjs`** -- `resolveSbdbObject(sstr)` (JPL's
  Small-Body Database: turns a typed name/designation into an exact
  SPK-ID, or an ambiguous-match list, or a not-found message) and
  `fetchHorizonsSpk({ spkid, startTime, stopTime })` (fetches that
  object's real trajectory SPK -- segment type 21, see
  `src/math/differenceArray.js` -- from Horizons, base64-decoded to
  raw bytes).
- **`scripts/closeApproach.mjs`** -- `fetchCloseApproachData()`: JPL's
  Close-Approach Data API, a fixed query (`dist-max=2LD`,
  `date-min=1900-01-01`, `diameter=true`) for `/close-approach/`'s own
  table.
- **The caching/serving glue in `scripts/serve-example.mjs`** --
  `handleHorizonsResolve`/`handleHorizonsSpk` (the latter backed by a
  real on-disk cache, one whole SPK + a `{start, stop}` sidecar per
  `spkid` in `kernels/cache/horizons/`, re-fetching the *union* of what's
  cached and what's newly requested whenever they don't already
  overlap) and `handleCloseApproachData` (an in-memory, 1-hour-TTL
  cache -- the dataset is bounded and slow-changing, so there's no
  reason to hit JPL on every page load).

**Endpoints exposed** (same-origin, so no CORS problem for the browser):

| Endpoint | Backed by |
| --- | --- |
| `GET /horizons/resolve?sstr=...` | `resolveSbdbObject()` |
| `GET /horizons/spk?spkid=...&start=...&stop=...` | `fetchHorizonsSpk()` + the on-disk cache |
| `GET /close-approach/data` | `fetchCloseApproachData()` + the in-memory cache |

**Consumed by** `examples/shared/horizonsClient.js` (layer 3's own thin
client wrapper for the first two endpoints -- see
[`examples/shared/api.md`](examples/shared/api.md#horizonsclientjs))
and directly, via plain `fetch()`, by `/close-approach/`'s own table
code for the third.

## 3. Visualization layer (three.js)

Renders real trajectories -- analytic ellipses and real sampled state
vectors alike -- from live kernel data, in the browser, with
`three.js`. Two generations of this exist side by side, deliberately:

- **`examples/browser-demo/`** -- the original, full-featured demo:
  every control exposed (Center, Frame, Rotating, Orbit mode, Period,
  Position/Radius scale), custom-kernel upload, Horizons search,
  Command+Click "precise mode." A single, self-contained
  `index.html` on purpose, so there's always one place every feature
  is exercised at once -- see its own
  [README](examples/browser-demo/README.md) for the full rundown.
- **The curated pages** -- fixed configurations built on
  `examples/shared/`'s extracted API (scale math, orbit/trajectory
  sampling, prefetch, satellite resolution, the Horizons client, and
  one small DOM-touching exception -- the "Reference epoch"
  text/datetime/UTC-TAI controls, `examples/shared/epochInput.js` --
  full reference in [`examples/shared/api.md`](examples/shared/api.md)):
  `solar-system/index.html`, `solar-system/trajectory/index.html`,
  `examples/shared/templates/body/index.html` and
  `.../body-trajectory/index.html` (served at `/<body>/` and
  `/<body>/trajectory/` for any of the ten built-in bodies -- there's
  no literal file per body; `scripts/serve-example.mjs` routes a known
  slug to the shared template), and `close-approach/index.html`.
  `examples/browser-demo/index.html` deliberately does **not** import
  from `examples/shared/` -- it stays independent, not refactored to
  share this code (its own copy of `epochInput.js`'s widget is kept in
  sync by hand for the same reason).

**Depends on layer 1 directly** -- every page imports `str2et`/
`et2utcCalendar`/`spkez`/`bodyValues`/`prop2b`/`openRemoteSpk`/
`openRemoteFile` etc. straight from `src/browser.js` -- **and on layer
2 over HTTP**, via `examples/shared/horizonsClient.js` and
`/close-approach/data`.

**Served by `scripts/serve-example.mjs`**, which -- beyond layer 2's
own endpoints -- also: serves the whole repo statically (so any page
can `import` straight from `src/`), proxies and range-caches the large
remote SPKs at `/kernels/remote/<file>.bsp` (`scripts/rangeCache.mjs` --
the server-side mirror of `src/lazy/remoteFile.js`'s own in-browser
caching), and routes `/<body>/`/`/<body>/trajectory/` to their shared
templates. `scripts/download-spk.mjs`/`scripts/inspect-spk.mjs` are
kernel-catalogue tooling this layer's proxy and layer 1's own
`kernels/sources.mjs` both lean on, not part of any one layer.

## How the three fit together: one request, end to end

A user on `/close-approach/` clicks a table row for a real close
approach:

1. **Layer 3** (`close-approach/index.html`) computes that approach's
   own epoch from the row's Julian date, moves the reference-epoch
   slider there, and calls `examples/shared/horizonsClient.js`'s
   `resolveHorizonsObject(des)`.
2. **Layer 2** (`/horizons/resolve`, `scripts/horizonsSpk.mjs`) resolves
   that designation to a real SPK-ID via JPL's Small-Body Database.
3. **Layer 3** calls `fetchHorizonsSpk({ spkid, start, stop })` for the
   approach date ±1 day.
4. **Layer 2** (`/horizons/spk`) serves it from `kernels/cache/horizons/`
   if already cached, or fetches it fresh from Horizons (and caches it)
   otherwise -- either way, real SPK bytes come back.
5. **Layer 3** hands those bytes to `examples/shared/kernelSession.js`'s
   `discoverSpkBodies()`/`prefetchCustomBody()`, which register the
   segment into the same kernel pool Earth/Moon already live in.
6. **Layer 1** (`src/spk.js`'s `spkez()`, called both directly and
   through `examples/shared/orbitMath.js`'s `computeOrbitState()`)
   evaluates the object's real position relative to Earth at whatever
   epoch is being drawn.
7. **Layer 3** converts each position to scene units
   (`examples/shared/scale.js`) and hands the resulting points to
   `three.js` as one `THREE.Line` -- see
   [`examples/shared/api.md`](examples/shared/api.md#rendering-a-trajectory-putting-it-together)
   for that last step in full.
