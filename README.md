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
  arbitrary target/observer pairs (`spkez()`) -- see below.

Not yet supported (all fail with a clear error, not a silent wrong
answer):
- Other binary kernels (PCK, CK) and DAS-based kernels (DSK) -- PCK/CK
  share SPK's DAF container (`src/daf.js`) and are natural next steps;
  DSK is a different container format entirely.
- SPK segment types other than 2 and 3 (Chebyshev) -- covers the vast
  majority of publicly distributed planetary/lunar kernels, but not
  e.g. spacecraft kernels using Lagrange/Hermite interpolation (types
  5, 8/9/12/13).
- Body **name** strings (`spkezr_c` takes `"EARTH"`; `spkez()` here
  takes the NAIF integer ID `399`) -- needs sourcing NAIF's ~563-entry
  built-in name table, a separate follow-up.
- Frame transforms -- `spkez()`/`spkState()` return positions in
  whatever frame the involved segments natively use (mixed frames
  along a chain, or between target and observer, is a clear error
  rather than a silent wrong answer), not an arbitrary requested frame.
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
means. What it does *not* do: resolve body name strings (`spkezr_c`'s
job, not implemented -- pass NAIF integer IDs) or rotate into a
requested frame (also not implemented -- a mismatched frame anywhere
along the chain, or between target and observer, is a clear error).

The binary format itself (`src/daf.js` for the generic DAF container,
`src/spk.js` for SPK's segment layout, Chebyshev evaluation, chaining,
and aberration correction) was derived directly from NAIF's own source
(`zzdafnfr.c`, `dafps.c`, `spkr02.c`/`spke02.c`, `spkr03.c`/`spke03.c`,
`spkgeo.c`, `spkssb.c`, `spkapp.c`, `stelab.c`, `stlabx.c`, `vrotv.c`,
`clight.c` in the [OpenSpace/Spice](https://github.com/OpenSpace/Spice)
mirror), not guessed at -- see the doc comments in those files for the
byte layout and the algorithms. Because a real `.bsp` is
tens-to-hundreds of megabytes and `naif.jpl.nasa.gov` isn't reachable
from every environment, the test suite validates this against
synthetic SPK files it builds itself (`test/helpers/writeSpk.js`)
encoding exactly-checkable linear trajectories, rather than a bundled
real kernel.

## Development

```sh
npm test        # runs the test suite (node's built-in test runner)
node examples/basic.mjs
node examples/spk.mjs
npm run crossval  # cross-validates str2et/spkez against spiceypy (needs `pip install spiceypy`) -- see crossval/README.md
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
