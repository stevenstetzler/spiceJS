# spiceJS

A JavaScript library for working with [NAIF SPICE](https://naif.jpl.nasa.gov/naif/)
kernels -- the files spacecraft mission teams use to describe time,
geometry, and ephemerides.

This is an early, from-scratch reimplementation (not a WASM port of
the official Toolkit) that started with the piece needed to do
anything useful with SPICE time: load a leapseconds kernel into a
**kernel pool** and convert time strings with **STR2ET**. The
[unofficial CSPICE mirror](https://github.com/OpenSpace/Spice) was
used as a reference for behavior, but the code here is a new
implementation in plain JavaScript.

## Status

Supported today:
- A kernel pool (`furnsh`/`unload`/`kclear`), matching SPICE's own
  implicit global pool plus the ability to use isolated pools.
- Loading **text kernels** (`KPL/LSK`, and generically any `KPL/*`
  variable-assignment kernel) and **meta-kernels** (`KPL/MK`, with
  `PATH_SYMBOLS`/`PATH_VALUES`/`KERNELS_TO_LOAD`).
- `str2et()`, following NAIF's own documented `str2et_c` grammar:
  UTC/TDB/TDT calendar strings, ISO strings, day-of-year strings,
  slash-delimited dates, and Julian dates (see below).
- `et2utc()` / `et2utcCalendar()` as a basic inverse, mostly useful
  for testing.
- Loading **binary SPK** (trajectory) kernels and reading the
  position/velocity they contain -- a direct, single-segment lookup
  (`spkState()`), and a chained, aberration-corrected query across
  arbitrary target/observer pairs, in either NAIF ID (`spkez()`) or
  body **name** string (`spkezr()`) form -- see below.
- Rotating a state into any of the 21 **built-in inertial frames**
  (J2000, B1950, ECLIPJ2000, GALACTIC, ...), the ~123 built-in
  **body-fixed** frames (`IAU_MARS`, `IAU_EARTH`, `IAU_MOON`, ...), or
  any frame defined by a loaded **frame kernel** (FK) -- via
  `spkez()`/`spkezr()`'s `ref` parameter.
- Loading **binary PCK** (body orientation) kernels (`pckSegments()`),
  used for the time-varying, angular-velocity-aware half of body-fixed
  frame support above.
- SPK segment types 2/3 (Chebyshev), **5 (two-body/Keplerian
  propagation)**, **8/9 (Lagrange)**, and **12/13 (Hermite)** -- covers
  essentially every publicly distributed planetary/lunar/satellite
  kernel and most spacecraft/station ones. `furnsh()` also accepts the
  older, generic `NAIF/DAF` ID word some real kernels use instead of
  `DAF/SPK`/`DAF/PCK` (routed by summary shape instead of the ID word
  text, matching real CSPICE).
- Reading arbitrary body constants from a loaded text PCK (e.g.
  `BODY399_RADII`, `BODY399_GM`) with `bodyValues(body, item)`.
- **`prop2b(gm, pvinit, dt)`**: NAIF's universal-variables two-body
  propagator, exposed directly as a standalone routine (not just an
  SPK type 5 implementation detail) -- propagates a state under pure
  Keplerian motion by `dt` seconds, uniformly across elliptical,
  parabolic, and hyperbolic orbits.
- **Running in a browser**: `load()`, `furnsh()`'s async sibling, loads
  a kernel from an http(s) URL, a `File`/`Blob` (a local-file picker or
  drag-and-drop selection), or raw bytes, optionally through a local
  cache (`createMemoryCache()`/`createIndexedDbCache()`). A bundler
  targeting the browser resolves `import ... from 'spicejs'` to a
  dedicated Node-free entry point automatically (`package.json`'s
  `exports` "browser" condition) -- see "Running in a browser" below.
- **Lazy-loading large kernels**: `openRemoteSpk()`/`openRemotePck()`
  fetch only the bytes a specific `(target, observer, etStart, etEnd)`
  query actually touches, via HTTP range requests -- a real 1-year
  query against a 32.7 MB planetary ephemeris fetches under 1% of the
  file. Covers SPK segment types 2/3/8/12/5/9/13 -- see "Lazy-loading
  large kernels" below.

Not yet supported (all fail with a clear error, not a silent wrong
answer):
- Other binary kernels (CK) and DAS-based kernels (DSK) -- CK shares
  SPK/PCK's DAF container (`src/daf.js`) and is a natural next step;
  DSK is a different container format entirely.
- CK (spacecraft-orientation), dynamic, and switch reference frames,
  and the one built-in class 4 frame in NAIF's table (`EARTH_FIXED`, a
  hardcoded ITRF93-relative frame, not PCK-driven). A mismatched frame
  anywhere in a chain, or between target and observer, is a clear
  error rather than a silent wrong answer.
- Orientation constants defined relative to an epoch or frame other
  than J2000 (`BODY#_CONSTANTS_JED_EPOCH`/`_REF_FRAME`) -- rare in
  practice; a loaded kernel that sets either is a clear error.
- Spacecraft clock (SCLK) strings and general time zones beyond the
  handful `str2et_c` itself documents (the U.S. zones, and `UTC±H:MM`).

## Install

This isn't published yet -- clone the repo and import from `src/`:

```js
import { furnsh, str2et, et2utc } from './src/index.js';
```

## Usage

```js
import { furnsh, str2et, et2utc } from './src/index.js';

// Load a leapseconds kernel (LSK) -- required for any UTC time string.
// A copy is included at kernels/naif0012.tls for convenience/testing;
// grab the latest from https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/
furnsh('./kernels/naif0012.tls');

const et = str2et('2026-08-11T12:00:00');
//=> 839721669.183026   (TDB seconds past J2000)

et2utc(et);
//=> '2026-08-11T12:00:00.000'

// A "TDB"/"ET" suffix skips the leapseconds correction entirely --
// no kernel needs to be loaded for these. Note the space, not "T":
// an ISO "T" string rejects any trailing label at all (matching
// real str2et_c), so a space-separated calendar string is needed to
// combine a date with a label.
str2et('2000-01-01 12:00:00 TDB');
//=> 0
```

### Supported `str2et` input formats

`str2et` follows the parsing rules documented for NAIF's own
[str2et_c](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/str2et_c.html)
(see `src/time/parseTimeString.js` for the rule-by-rule implementation
and a large regression test transcribed directly from that page's
examples):

```
ISO ("T") formats
  2026-08-11T12:00:00.500, 2026-08-11 12:00:00
  1986-01-18T12, 1986-01-18T12:19:52.18Z
  1995-08T18:28:12          (2 date fields -> Year + Day-of-Year)

Calendar formats, month by name, in any field order
  2026 AUG 11 12:00:00, 11 AUG 2026 12:00:00, AUG 11, 2026 12:00:00
  17JUN1982 18:28:28        (letters need not be delimited from digits)
  Tue Aug 6 11:10:57 1996   (weekday is ignored)
  '93 Jan 23 ...            (quoted 2-digit year)
  23 A.D. APR 4 ..., 18 B.C. Jun 3 ...

Slash-delimited numeric dates (Month/Day/Year assumed)
  2/3/1996 17:18:12.002, 1978/3/12 23:28:59.29

Day-of-year formats (Year/DOY pair + "//", "::", or "/" marker,
time-of-day leading or trailing)
  1997-162::12:18:28.827, 162-1996/12:28:28.287, 17:28:01.287 1992-272//

Julian dates -- "JD"/"jd" may appear before or after the number
  JD 2451545.0, 2451545.0 JD, 2451545.0 (JD)

Labels, anywhere in the string
  ... TDB / ... TDT / ... UTC   time system
  ... A.M. / ... P.M.
  ... EST/EDT/CST/CDT/MST/MDT/PST/PDT, ... UTC+5:30
```

A calendar string needs either an ISO `YYYY-MM-DD` date or a month
name -- three numeric fields with no month name (e.g. `01 02 03`) is
rejected as ambiguous rather than guessed at, matching NAIF's own
"ambiguous string" behavior.

An ISO string using a literal `"T"` separator is stricter than every
other format here: it rejects *any* trailing label (time system, time
zone, A.M./P.M.) even though the identical date with a space instead
of `"T"` accepts all of them -- `"2000-01-01T12:00:00 TDB"` is
rejected, `"2000-01-01 12:00:00 TDB"` isn't. This isn't a spiceJS
restriction; it's exactly how real `str2et_c` behaves (confirmed
against spiceypy -- see `crossval/`). A trailing `Z` is fine either
way, since it's part of the ISO shape itself, not a "label".

UTC epochs before 1972-JAN-1, where the leapseconds table starts,
don't error -- they extrapolate using one second less than the
table's first `DELTA_AT` entry, for every earlier epoch, matching real
`str2et_c` bit-for-bit (also confirmed against spiceypy). This isn't
physically meaningful -- UTC before 1972 wasn't defined by whole-second
leaps at all -- it's just what NAIF's own toolkit does.

### Isolated kernel pools

`furnsh`/`unload`/`kclear`/`str2et`/`et2utc` all default to a shared
module-level pool, mirroring SPICE's implicit global kernel pool. Pass
an explicit pool (e.g. in tests) to keep state isolated:

```js
import { KernelPool, furnsh, str2et } from './src/index.js';

const pool = new KernelPool();
furnsh('./kernels/naif0012.tls', pool);
str2et('2026-08-11T12:00:00', pool);
```

## How time conversion works

`str2et` follows the same model NAIF's own Toolkit uses, driven
entirely by values loaded from the leapseconds kernel rather than
hardcoded constants:

```
TT (= TDT) = UTC + DELTA_AT + DELTA_T_A
ET (= TDB) = TT + K * sin(E)
E          = M0 + M1 * T + EB * sin(M0 + M1 * T)
```

- `DELTA_AT` is the whole-second TAI-UTC leap second count in effect
  at the given UTC instant, looked up from the `DELTET/DELTA_AT`
  table the LSK loads into the pool.
- `DELTA_T_A`, `K`, `EB`, and `M` come from the LSK's `DELTET/*`
  variables and model the (sub-millisecond) periodic difference
  between Terrestrial Time and Barycentric Dynamical Time.

A `TDT`-labeled string skips straight to the second equation (it's
already TT); a `TDB`-labeled string skips both entirely.

See `src/time/deltet.js` and `src/time/calendar.js` for the full
implementation and comments.

## Reading trajectories from binary SPK kernels

```js
import { furnsh, spkState, spkSegments } from './src/index.js';

furnsh('/path/to/de440s.bsp');

spkSegments();
//=> [{ target: 499, center: 0, frame: 1, type: 2, startEt: ..., stopEt: ... }, ...]

// Mars (499) relative to the Solar System Barycenter (0), in km / km/s,
// in the segment's native frame (J2000 for most generic kernels).
const { position, velocity } = spkState(499, 0, someEt);
```

`spkState(target, center, et, pool?)` is a **direct** lookup: it needs
a loaded segment whose `(target, center)` match exactly (use
`spkSegments()` to see what's available). For most generic planetary
kernels this covers the common cases directly (e.g. any planet
relative to the SSB, the Moon relative to the Earth-Moon barycenter).
Segment types 2/3 (Chebyshev), 5 (two-body propagation), 8/9
(Lagrange), and 12/13 (Hermite) are all supported transparently --
`spkState()`/`spkez()`/`spkezr()` don't need to know which one a given
segment uses.

For an arbitrary target/observer pair, use `spkez()` -- it's SPICE's
`spkez_c`: it chains through intermediate bodies back to the Solar
System Barycenter (the same way NAIF's own `spkgeo_c`/`spkssb_` do)
and applies light-time and/or stellar aberration correction:

```js
import { spkez } from './src/index.js';

// Earth (399) relative to the SSB (0) -- even though a typical DE
// kernel only stores Earth relative to the Earth-Moon barycenter (3)
// and the EMB relative to the SSB, spkez() connects the two hops.
const { position, velocity, lightTime } = spkez(399, 0, someEt);
//=> geometric state (no correction) -- the default, same as spkState()

spkez(399, 0, someEt, 'LT+S');
//=> light-time + stellar-aberration corrected apparent state, as an
//   observer sitting at the SSB would actually see it
```

`abcorr` accepts the same 9 values as `spkez_c`: `'NONE'` (default),
`'LT'`/`'LT+S'` (one-iteration light time, "reception" case, optionally
with stellar aberration), `'CN'`/`'CN+S'` (3-iteration converged light
time), and the `'X...'`-prefixed "transmission" case equivalents of
each. See the doc comment on `spkez()` in `src/spk.js` for what each
means.

For body **name** strings instead of NAIF integer IDs, use `spkezr()`
-- SPICE's `spkezr_c` -- which just resolves both names and calls
`spkez()`:

```js
import { spkezr } from './src/index.js';

spkezr('MOON', 'EARTH', someEt, 'LT+S');
// Names are matched case-insensitively, with internal whitespace
// collapsed (but not interchangeable with underscores -- "EARTH
// BARYCENTER" and "EARTH_BARYCENTER" are both separately valid
// NAIF aliases): 'moon', 'Moon', 'MOON' all resolve the same way.
// A loaded kernel's NAIF_BODY_NAME/NAIF_BODY_CODE pool variables
// (see bodies.js) take priority over the ~692-entry built-in table,
// so an FK can add or override names.
```

To express a result in a specific reference frame instead of whatever
frame the segments natively use, pass `ref` (both `spkez()` and
`spkezr()` take it as the 5th argument, before `pool`):

```js
spkez(499, 0, someEt, 'LT+S', 'ECLIPJ2000');
spkezr('MARS', 'SSB', someEt, 'LT+S', 'ECLIPJ2000');
```

`ref` accepts the name of any of the **21 built-in inertial frames**
(`J2000`, `B1950`, `FK4`, `GALACTIC`, `ECLIPJ2000`, `ECLIPB1950`, and
the `DE-*` ephemeris frames -- see `src/data/inertialFrames.js` for
the full list), any of the **~123 built-in body-fixed frames**
(`IAU_MARS`, `IAU_EARTH`, `IAU_MOON`, ... -- see
`src/data/bodyFixedFrames.js`), or a frame defined by a loaded frame
kernel (see "Body-fixed frames and frame kernels" below). Omit `ref`
(or pass `null`) to get the native, unrotated frame, same as before.
If the segments involved don't already agree on one native frame,
that's still a clear error regardless of `ref` -- there's no
rotation to reconcile mismatched *inputs*, only to produce a requested
*output*.

The binary format itself (`src/daf.js` for the generic DAF container,
`src/spk.js` for SPK's segment layout, Chebyshev evaluation, chaining,
and aberration correction; `src/bodies.js`/`src/frames.js` for name and
frame resolution) was derived directly from NAIF's own source
(`zzdafnfr.c`, `dafps.c`, `spkr02.c`/`spke02.c`, `spkr03.c`/`spke03.c`,
`spkgeo.c`, `spkssb.c`, `spkapp.c`, `stelab.c`, `stlabx.c`, `vrotv.c`,
`clight.c`, `zzidmap.c`, `chgirf.c` in the
[OpenSpace/Spice](https://github.com/OpenSpace/Spice) mirror), not
guessed at -- see the doc comments in those files, and
`scripts/extract-body-ids.mjs`/`scripts/extract-inertial-frames.mjs`
(which parse that source directly into `src/data/*.js` rather than
hand-transcribing ~700 names and 21 rotation matrices), for the byte
layout and the algorithms. Because a real `.bsp` is tens-to-hundreds of
megabytes and `naif.jpl.nasa.gov` isn't reachable from every
environment, the test suite validates this against synthetic SPK files
it builds itself (`test/helpers/writeSpk.js`) encoding
exactly-checkable linear trajectories, rather than a bundled real
kernel -- and `crossval/` (see below) checks it against real CSPICE
directly.

## Body-fixed frames and frame kernels

Beyond the 21 fixed-matrix inertial frames, `ref` also resolves
**body-fixed** frames -- ones that rotate with a planet or moon, so
their orientation (and its time derivative, for the velocity half of a
state) has to be evaluated at the epoch of interest:

```js
import { furnsh, spkezr } from './src/index.js';

furnsh('/path/to/pck00010.tpc'); // text PCK: classic BODY#_POLE_RA/DEC/PM constants
furnsh('/path/to/de440s.bsp');

// Earth's state relative to the Sun, expressed in Mars' body-fixed frame.
spkezr('EARTH', 'SUN', someEt, 'LT+S', 'IAU_MARS');
```

`IAU_MARS`/`IAU_EARTH`/`IAU_MOON`/... are ~123 built-in frames driven
by the classic RA/DEC/W polynomial-plus-periodic-term orientation
formula (NAIF's `tisbod.c`/`bodeul.c`), read from a loaded text PCK's
`BODY#_POLE_RA`/`_POLE_DEC`/`_PM` (and optional `_NUT_PREC_*`)
variables -- see `src/bodyOrientation.js`.

Loading a **binary PCK** (`furnsh('/path/to/moon_pa_de440.bpc')`) adds
higher-accuracy, Chebyshev-fit orientation data, indexed by frame ID
rather than body ID; `frames.js` prefers it over the classic formula
whenever both are available for the requested frame and epoch, per
NAIF's own documented priority. A loaded **frame kernel** (FK, an
ordinary `KPL/FK` text kernel -- no special loading code needed) can
additionally define:
- new **PCK-driven** frame names/IDs pointing at a binary PCK's own
  frame ID (e.g. `MOON_PA_DE440`, backing the generic `MOON_PA` alias);
- **fixed-offset (TK)** frames, a constant rotation (`MATRIX`, or
  `ANGLES`+`AXES`+`UNITS`) relative to another named frame (e.g.
  `MOON_ME_DE440_ME421`, offset from `MOON_PA_DE440`).

Both orientation formula, both binary PCK types, and the TK frame math
(`src/math/eulerFrame.js`'s `TIPM`/`DTIPM` construction) were verified
against real NAIF-distributed kernels and cross-checked against
spiceypy loading the *same* files, not just synthetic fixtures -- see
`crossval/pck00010.tpc`.

## Body constants

Any `BODY<id>_<ITEM>` value from a loaded text PCK -- radii, GM, or
anything else a given kernel defines -- is available via `bodyValues()`
(NAIF's `bodvcd_c`/`bodvrd_c`, unified into one function since there's
no chaining involved that would justify separate ID- and name-based
entry points the way `spkez()`/`spkezr()` have):

```js
import { furnsh, bodyValues } from './src/index.js';

furnsh('/path/to/pck00011.tpc');

bodyValues(399, 'RADII');   // => [6378.1366, 6378.1366, 6356.7519]
bodyValues('EARTH', 'GM');  // by name too, same resolution rules as spkezr()
```

## Two-body propagation

`prop2b(gm, pvinit, dt)` -- NAIF's `prop2b_c` -- propagates a state
`[x, y, z, vx, vy, vz]` (km, km/s) forward or backward by `dt` seconds
under pure Keplerian (two-body) motion about a center with
gravitational parameter `gm` (km^3/s^2), using the universal-variables
formulation so it works uniformly across elliptical, parabolic, and
hyperbolic orbits:

```js
import { prop2b } from './src/index.js';

const gm = 398600.4418; // Earth
const pvinit = [7000, 0, 0, 0, 7.5461, 0]; // ~circular LEO
prop2b(gm, pvinit, 3600); // state one hour later, ignoring perturbations
```

This is also the building block SPK segment type 5 is evaluated with
(`src/spk.js`'s `evaluateType5()`): each type 5 segment stores a
handful of states, and reading one at a given `et` means propagating
the two bracketing states to `et` via `prop2b` and blending them with
a cosine weight -- not interpolating stored samples, unlike every
other supported SPK type.

## Running in a browser

`furnsh()` is deliberately synchronous and Node-only (`fs.readFileSync`
under the hood), so it stays exactly as-is. `load()` is its async,
environment-agnostic sibling for everything else -- an http(s) URL
(fetched), a `File`/`Blob` (a `<input type="file">`/drag-and-drop
selection, or the File System Access API), or raw
`ArrayBuffer`/`Uint8Array` bytes:

```js
import { load, spkezr } from 'spicejs';

await load('https://your-cors-enabled-host/naif0012.tls');
await load('https://your-cors-enabled-host/de440s.bsp');

spkezr('MARS', 'SSB', someEt, 'LT+S');
```

A kernel loaded via `load()` is unloadable via `unload()`, and
forgotten by `kclear()`, exactly like one loaded via `furnsh()` -- both
share the same per-pool load history.

**Two entry points, resolved automatically.** `import ... from
'spicejs'` in Node resolves to `src/index.js` (everything, including
`furnsh()`); the same import in a browser-targeting bundler
(Vite/webpack/esbuild) resolves instead to `src/browser.js` --
everything *except* `furnsh()` -- via `package.json`'s `exports`
`"browser"` condition, which every mainstream bundler honors by
default. This isn't just a convenience wrapper: pulling `load()` in
via `src/index.js` in a browser bundle would, despite `furnsh()` itself
never being called, still fail to bundle at all -- a bundler has to
*resolve* every static import reachable from a barrel file's
re-exports (including `src/index.js`'s own `import fs from 'node:fs'`)
before it can tree-shake anything unused, and `node:fs`/`node:path`
don't exist in a browser. Verified directly with a real
`esbuild --platform=browser` build, not just asserted -- importing
straight from `src/browser.js` (or the package specifier, once a
bundler applies the `"browser"` condition) produces a bundle with zero
`node:*` references; importing the same names from `src/index.js`
doesn't bundle for `browser` at all. If your bundler doesn't apply
`exports` conditions for some reason, import `spicejs/browser` (a
dedicated subpath export pointing at the same `src/browser.js`)
directly instead of the bare package specifier.

Meta-kernels (`KPL/MK`) work the same way: `load()`ing one fetches and
expands it, resolving each `KERNELS_TO_LOAD` entry (after
`PATH_SYMBOLS` substitution) as a URL *relative to the meta-kernel's
own URL* -- the same relationship `furnsh()` already has to a meta-
kernel's directory on disk.

**A note on CORS**: `naif.jpl.nasa.gov` itself doesn't send
`Access-Control-Allow-Origin`, so a browser page on another origin
can't `fetch()` it directly -- no client-side trick fixes a missing
CORS header on someone else's server. Either let users pick an
already-downloaded kernel locally (the `File`/`Blob` path above, which
has no CORS question at all), or re-host/proxy kernels somewhere that
does send the header (a CORS-enabled bucket/CDN, or a small proxy --
even a ~20-line edge function that fetches from NAIF server-side and
adds the header). See `docs/browser-support.md` for the full
investigation this is based on, including what was actually confirmed
against real `naif.jpl.nasa.gov` responses.

### Caching kernels locally

`load()` takes an optional `cache`, consulted before fetching and
populated after a miss, so a repeat `load()` of the same URL doesn't
re-download it:

```js
import { load, createIndexedDbCache } from 'spicejs';

const cache = createIndexedDbCache(); // persists across page loads
await load('https://your-cors-enabled-host/de440s.bsp', undefined, { cache });
```

`createIndexedDbCache()` is browser-only (feature-detected -- it
throws a clear error if `indexedDB` isn't available, e.g. called from
plain Node); `createMemoryCache()` works everywhere, including Node,
but only for the current process's lifetime. Both cache whole kernel
files, keyed by URL -- there's no partial/range-based loading yet (see
`docs/browser-support.md` §3.6 for that as a documented future
direction, not something implemented here).

### Overriding how `load()` resolves a reference

Pass a `resolve` option to handle a reference type `load()`'s default
resolver doesn't (a Node local path via `fs`, an authenticated fetch,
an Electron IPC round trip to the main process, ...) -- it fully
replaces the default resolver (URL/File/Blob/raw-bytes handling
included), so provide whatever coverage you need:

```js
import fs from 'node:fs/promises';
import { load } from 'spicejs'; // a Node context here, so this resolves to src/index.js -- load() is exported from both entry points

await load('/local/path/to/kernel.bsp', undefined, {
  resolve: (reference) => fs.readFile(reference),
});
```

## Lazy-loading large kernels

`load()` downloads a whole kernel file. For something the size of a
planetary ephemeris (`de440.bsp` is over 100 MB), that's often far
more than a given query actually needs -- `openRemoteSpk()`/
`openRemotePck()` fetch only the specific bytes a `(target, observer,
etStart, etEnd)` (or, for PCK, `(frame, etStart, etEnd)`) query
touches, via HTTP range requests:

```js
import { openRemoteSpk, spkez } from 'spicejs';

const remote = await openRemoteSpk('https://your-cors-enabled-host/de440.bsp');
await remote.prefetch({ target: 399, observer: 0, etStart: t1, etEnd: t2 });

// Ordinary, synchronous, unmodified spkez() from here on.
const { position, velocity } = spkez(399, 0, someEtBetweenT1AndT2, 'NONE', null, remote.pool);
```

For a real 1-year query against `de440s.bsp` (32.7 MB), this fetches
**5 HTTP requests totaling ~280 KB -- under 1% of the file** --
verified against the real, NAIF-distributed file, matching `spiceypy`
to full double precision. See `docs/lazy-loading.md` for the full
scoping (the byte-range math per segment type, the architecture
decision, and real numbers this claim is based on) and its
implementation status.

`prefetch()` is incremental (already-fetched bytes are never
re-fetched) and idempotent (already-registered segments are never
re-added), so calling it again -- widening the time window, or for a
different target/observer pair against the same file -- is cheap and
safe. Querying an epoch outside what's been prefetched throws a clear,
catchable error (not a wrong answer) -- catch it, call `prefetch()`
again with a wider window, and retry:

```js
try {
  spkez(399, 0, someOtherEt, 'NONE', null, remote.pool);
} catch (err) {
  await remote.prefetch({ target: 399, observer: 0, etStart: someOtherEt - margin, etEnd: someOtherEt + margin });
  spkez(399, 0, someOtherEt, 'NONE', null, remote.pool); // now covered
}
```

If you're using light-time correction (`abcorr` other than `'NONE'`),
pass `lightTimeMargin` (seconds) to widen the prefetched window enough
to cover `et ± lightTime` -- light times within the solar system range
from ~8 minutes (Sun-Earth) to several *hours* for the outer planets
(Neptune: ~4.2 light-hours; Pluto: up to ~6.5), so pick a margin
appropriate to the bodies actually involved:

```js
await remote.prefetch({ target: 399, observer: 0, etStart: t1, etEnd: t2, lightTimeMargin: 5 * 3600 });
spkez(399, 0, someEt, 'LT+S', null, remote.pool);
```

`openRemoteSpk()`/`openRemotePck()` take the same `cache`/
`resolveRange`/`fileLength`/`blockBytes` options as `load()`'s
caching support (see `createMemoryCache()`/`createIndexedDbCache()`
above) -- fetches are cached in fixed-size, block-aligned chunks
rather than whole files, so a second query against a previously-cached
file benefits even when it touches a different part of the kernel.

Segment types 2/3 (Chebyshev), 8/12 (Lagrange/Hermite, equal step),
and 5/9/13 (Lagrange/Hermite/two-body, unequal step) are supported --
covering `de440`/`de440s` and the large majority of real distributed
kernels. Very-high-cadence unequal-step kernels (hundreds of thousands
of epochs or more) aren't optimally supported yet -- see
`docs/lazy-loading.md`'s Phase 4.

## Development

```sh
npm test        # runs the test suite (node's built-in test runner)
node examples/basic.mjs
node examples/spk.mjs
node examples/pck.mjs
npm run crossval  # cross-validates str2et/spkez/spkezr against spiceypy (needs `pip install spiceypy`) -- see crossval/README.md
```

`src/data/bodyIds.js`, `src/data/inertialFrames.js`, and
`src/data/bodyFixedFrames.js` are generated, not hand-written --
re-run their extractors against a local clone of
[OpenSpace/Spice](https://github.com/OpenSpace/Spice) if NAIF's tables
ever change:

```sh
node scripts/extract-body-ids.mjs          <path-to-clone>/src/common/zzidmap.c
node scripts/extract-inertial-frames.mjs   <path-to-clone>/src/common/chgirf.c
node scripts/extract-body-fixed-frames.mjs <path-to-clone>/src/common/zzfdat.c
```

## Acknowledgements

The [NAIF SPICE Toolkit](https://naif.jpl.nasa.gov/naif/toolkit.html)
and its [unofficial GitHub mirror](https://github.com/OpenSpace/Spice)
were used as the behavioral reference. `kernels/naif0012.tls` is
NAIF's own publicly distributed leapseconds kernel, included here as a
test fixture and usage example. [spiceypy](https://github.com/AndrewAnnex/SpiceyPy)
(a Python wrapper around the real CSPICE library) is used in
`crossval/` to cross-check spiceJS's output against real CSPICE
directly, rather than relying solely on documentation and hand
derivation -- it's how the two behavioral quirks noted above (ISO `"T"`
strings rejecting trailing labels, and the pre-1972 `DELTA_AT`
extrapolation) were actually discovered.
