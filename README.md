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
- SPK segment types 2/3 (Chebyshev), **8/9 (Lagrange)**, and **12/13
  (Hermite)** -- covers essentially every publicly distributed
  planetary/lunar/satellite kernel and most spacecraft/station ones.
  `furnsh()` also accepts the older, generic `NAIF/DAF` ID word some
  real kernels use instead of `DAF/SPK`/`DAF/PCK` (routed by summary
  shape instead of the ID word text, matching real CSPICE).
- Reading arbitrary body constants from a loaded text PCK (e.g.
  `BODY399_RADII`, `BODY399_GM`) with `bodyValues(body, item)`.

Not yet supported (all fail with a clear error, not a silent wrong
answer):
- Other binary kernels (CK) and DAS-based kernels (DSK) -- CK shares
  SPK/PCK's DAF container (`src/daf.js`) and is a natural next step;
  DSK is a different container format entirely.
- SPK/PCK segment type 5 (discrete two-body/Keplerian propagation) --
  unlike the interpolated types above, this needs a genuinely new
  two-body propagator, and is rare in real kernels (superseded by
  9/13 in practice).
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
Segment types 2/3 (Chebyshev), 8/9 (Lagrange), and 12/13 (Hermite) are
all supported transparently -- `spkState()`/`spkez()`/`spkezr()` don't
need to know which one a given segment uses.

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
