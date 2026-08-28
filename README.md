# spiceJS

A JavaScript library for working with [NAIF SPICE](https://naif.jpl.nasa.gov/naif/)
kernels — the files spacecraft mission teams use to describe time,
geometry, and ephemerides. Runs in Node and in the browser (including
lazy, byte-range loading of multi-gigabyte kernels straight from
NAIF).

This is a from-scratch reimplementation, not a WASM port of the
official Toolkit. Behavior is derived directly from real CSPICE
source in the [OpenSpace/Spice](https://github.com/OpenSpace/Spice)
unofficial mirror (`zzdafnfr.c`, `spkr02.c`/`spke02.c`, `spkgeo.c`,
`spkapp.c`, `chgirf.c`, and others — see the doc comments in the
relevant `src/*.js` files for exactly which routine each piece
follows), and cross-checked against real CSPICE output via
[spiceypy](https://github.com/AndrewAnnex/SpiceyPy) in `crossval/`
rather than relying on documentation and hand derivation alone — see
"Validating against real CSPICE" below.

## Features

- A **kernel pool** (`furnsh`/`unload`/`kclear`), matching SPICE's
  implicit global pool, plus isolated pools for tests/apps that need
  independent state.
- **Text kernels** (`KPL/LSK`, and generically any `KPL/*`
  variable-assignment kernel) and **meta-kernels** (`KPL/MK`).
- **`str2et()`**/**`et2utc()`**, following NAIF's own documented
  `str2et_c` grammar (ISO, calendar, day-of-year, Julian date, and
  more — see `src/time/parseTimeString.js`'s doc comment for the full
  rule-by-rule grammar and worked examples).
- **Binary SPK** (trajectory) reading — direct segment lookup
  (`spkState()`) and chained, aberration-corrected queries across
  arbitrary target/observer pairs by NAIF ID (`spkez()`) or body
  **name** (`spkezr()`). Segment types **2/3** (Chebyshev), **5**
  (two-body/Keplerian propagation), **8/9** (Lagrange), **12/13**
  (Hermite), and **21** (extended difference lines — the format JPL
  Horizons exports small-body/comet trajectories in) are all
  supported — essentially every publicly distributed
  planetary/lunar/satellite/spacecraft kernel, plus custom
  Horizons-generated ones.
- **Body name lookup**, both directions (`bodyCode()`/`bodyName()`) —
  a ~692-entry built-in NAIF ID/name table (`src/bodies.js`),
  overridable/extendable by a loaded kernel's own `NAIF_BODY_NAME`/
  `NAIF_BODY_CODE` pool variables.
- **Reference frames** — the 21 built-in inertial frames (`J2000`,
  `ECLIPJ2000`, `B1950`, `GALACTIC`, ...), ~123 built-in body-fixed
  frames (`IAU_MARS`, `IAU_EARTH`, `IAU_MOON`, ...), and frames defined
  by a loaded **frame kernel** (FK) — fixed-offset (TK) frames and
  binary-PCK-backed frame names.
- **Binary PCK** reading (`pckSegments()`) for higher-accuracy,
  time-varying body orientation, preferred over the classic
  RA/DEC/W formula when both are available.
- **Body constants** (`bodyValues()`) — any `BODY<id>_<ITEM>` from a
  loaded text PCK (radii, GM, ...).
- **`prop2b()`** — NAIF's universal-variables two-body propagator,
  exposed standalone (elliptical, parabolic, and hyperbolic orbits
  uniformly).
- **Runs in the browser** — `load()`, an async sibling of `furnsh()`,
  loads from a URL, a `File`/`Blob`, or raw bytes, with optional
  memory/IndexedDB caching. A dedicated `src/browser.js` entry point
  (resolved automatically via `package.json`'s `exports` "browser"
  condition) keeps Node-only code out of browser bundles.
- **Lazy-loading** — `openRemoteSpk()`/`openRemotePck()` fetch only
  the HTTP byte ranges a given `(target, observer, etStart, etEnd)`
  query actually touches. A real 1-year query against a 32.7 MB
  ephemeris fetches under 1% of the file.

Not yet supported (CK/DSK kernels, dynamic/switch frames, SCLK, and a
few other gaps — each fails with a clear error, never a silently wrong
answer) — see [`TODO.md`](TODO.md).

## Install

Not published yet — clone the repo and import from `src/`:

```js
import { furnsh, str2et, spkezr } from './src/index.js';

furnsh('./kernels/naif0012.tls'); // leapseconds kernel, included for convenience
furnsh('./de440s.bsp');           // any real SPK you've downloaded -- see below

const et = str2et('2026-08-11T12:00:00');
spkezr('MARS', 'SSB', et, 'LT+S');
```

In a browser (via a bundler), the same package specifier resolves to
a Node-free entry point automatically:

```js
import { load, spkezr } from 'spicejs';
await load('https://your-cors-enabled-host/de440s.bsp');
```

See `examples/basic.mjs`, `examples/spk.mjs`, `examples/pck.mjs` for
runnable end-to-end examples, and the doc comment on each exported
function (`src/*.js`) for full parameter/behavior details.

## Downloading kernels

Real SPK kernels are large (the ten this repo knows about total
**8 GB**), so none are checked in. Two ways to get them:

```sh
npm run serve-example           # runs a local range-caching proxy -- see below; no full download needed
npm run download-spk -- --list  # or: download a whole file for offline use / a tool that can't do ranged reads
npm run download-spk -- de440s
```

See [`kernels/README.md`](kernels/README.md) for the full kernel
catalogue, real sizes, and caveats found by reading the actual files
(e.g. Saturn's moons being split across two NAIF kernels).

## Running the example website / visualization tool

```sh
npm run serve-example
```

Then open **http://localhost:8080/examples/browser-demo/**. This
serves the repo *and* a local proxy that streams NAIF kernels on
demand via HTTP range requests (so even a multi-gigabyte kernel costs
a few hundred KB to open) — the demo detects the proxy and auto-loads
`de440s` through it, so the page opens already showing the live Solar
System, no click needed.

The demo plots ten Solar System bodies with three.js: explicit view
controls (Center, Frame, Rotating, Orbit, Period, Position scale,
Radius scale) and per-body actions (Look, From) drive the whole-system
view, Command+Click a body for a true-to-scale single-body-and-its-moons
view, or load your own `.bsp` -- or fetch one live from
[JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) by name or
designation -- to add extra bodies (asteroids, comets, spacecraft,
even unbound flyby/escape trajectories) onto the live session, each
rendered with the same real orbit-ellipse (or, if unbound, open-arc)
treatment as the ten built-in bodies. See
[`examples/browser-demo/README.md`](examples/browser-demo/README.md)
for the full feature rundown.

Several smaller, curated pages built on top of the same lazy-loading
machinery -- each a fixed configuration rather than the full explorer's
every-control-exposed design, all bounded to `de440s`'s 1900-2100
range. Every "Bodies shown" row gets a **Look** button (re-aims the
camera at that body, tracking it as the reference epoch scrubs); the
two `*/trajectory/` pages also get a **From** button per row (changes
the observer everything else is positioned relative to):

| Page | Shows |
| --- | --- |
| `/solar-system/` | The ten built-in bodies, viewed from the Sun, orbit ellipses only. Includes a JPL Horizons search box for adding asteroids/comets, always fetched over the full 1900-2100 range. |
| `/solar-system/trajectory/` | The same view, but every orbit line is a real sampled trajectory instead of an idealized ellipse, and View From lets you re-center on any displayed body (not just the Sun). Supports uploading a local `.bsp` to add its own trajectory. |
| `/<body>/` (e.g. `/earth/`, `/jupiter/`) | A true-to-scale (Linear position, Linear radius) view of one body and its known natural satellites, viewed from and looking at that body. |
| `/<body>/trajectory/` | The same single-body system, with each satellite's orbit line a real sampled trajectory, View From to re-center on any satellite (the central body's own line then mirrors whichever satellite is the observer), and support for adding a custom trajectory (e.g. a spacecraft) to that system. |
| `/close-approach/` | Earth + Moon, with a sortable, searchable table (designation, distance in lunar distances, date, H, diameter) of every real close approach within 2 lunar distances since 1900, from [JPL's Close-Approach Data API](https://ssd-api.jpl.nasa.gov/doc/cad.html). Click a row to jump the reference epoch to that approach (restricting the epoch slider to the object's own &plusmn;1-day fetched span) and fetch its real trajectory from Horizons -- only one such object is shown at a time, so selecting a new one replaces whichever was there before. |

`<body>` is any of `sun`, `mercury`, `venus`, `earth`, `mars`,
`jupiter`, `saturn`, `uranus`, `neptune`, `pluto` -- see
`examples/shared/bodies.js`'s `bodySlug()`. These page *shapes* share
their non-UI logic (scale math, orbit/trajectory sampling, prefetch,
satellite resolution, the Horizons client) via plain ES modules under
`examples/shared/` -- see [`examples/shared/api.md`](examples/shared/api.md)
for what's in them -- imported by each page rather than copy-pasted --
`examples/browser-demo/index.html` itself stays a single self-contained
file, deliberately not refactored to share this code, so it remains the
one place every feature is exercised at once.

## Development

```sh
npm test                       # node's built-in test runner
npm run crossval               # cross-validate against spiceypy -- see below
npm run perf                   # lazy-loading network/accuracy benchmark against real de440.bsp
npm run inspect-spk -- --check # re-verify kernels/sources.mjs against the live NAIF files
```

### Validating against real CSPICE

`spiceypy` (a Python wrapper around the real CSPICE library) is the
closest thing to ground truth reachable without a CSPICE build of our
own, so it's used throughout instead of relying solely on
documentation and hand derivation:

```sh
pip install spiceypy
npm run crossval
```

This generates synthetic kernels and a shared case list, runs them
through both spiceJS and spiceypy, and diffs the results — covering
`str2et`, `spkez`/`spkezr`/`spkState`, `bodyValues`, and `prop2b`, plus
several real, unmodified NAIF-distributed kernels checked in for
segment-type/binary-format validation. Two real behavioral quirks
(ISO `"T"` strings rejecting trailing labels; pre-1972 `DELTA_AT`
extrapolation) were only found this way. See
[`crossval/README.md`](crossval/README.md) for what's covered and
what isn't, and what it's caught.

## Documentation

| Topic | Where |
| --- | --- |
| Install, run, and deploy — the library, the example site, and a real production deployment; plus live-measured bandwidth per view | [`deploy.md`](deploy.md) |
| Code structure — the three layers (core library, Horizons/CAD caching, visualization) and how they fit together | [`modules.md`](modules.md) |
| Kernel catalogue, sizes, caveats | [`kernels/README.md`](kernels/README.md) |
| Browser demo — full feature rundown | [`examples/browser-demo/README.md`](examples/browser-demo/README.md) |
| Visualization API — the shared modules behind the curated demo pages | [`examples/shared/api.md`](examples/shared/api.md) |
| Lazy/range-based loading — design, byte-range math, real numbers | [`docs/lazy-loading.md`](docs/lazy-loading.md) |
| Running in a browser — CORS, bundling, entry points | [`docs/browser-support.md`](docs/browser-support.md) |
| Cross-validation against spiceypy | [`crossval/README.md`](crossval/README.md) |
| Lazy-loading network/accuracy benchmark | [`perf/README.md`](perf/README.md) |
| Not yet implemented | [`TODO.md`](TODO.md) |

`src/data/bodyIds.js`, `src/data/inertialFrames.js`, and
`src/data/bodyFixedFrames.js` are generated from the OpenSpace/Spice
mirror's own source, not hand-transcribed — re-run
`scripts/extract-*.mjs` against a local clone if NAIF's tables ever
change.

## Acknowledgements

The [NAIF SPICE Toolkit](https://naif.jpl.nasa.gov/naif/toolkit.html)
and its [unofficial GitHub mirror](https://github.com/OpenSpace/Spice)
were used as the behavioral reference throughout. `kernels/naif0012.tls`
is NAIF's own publicly distributed leapseconds kernel, included here
as a test fixture and usage example. [spiceypy](https://github.com/AndrewAnnex/SpiceyPy)
is used in `crossval/` to cross-check spiceJS's output against real
CSPICE directly.
