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
- `str2et()` for UTC and TDB calendar strings and Julian dates.
- `et2utc()` / `et2utcCalendar()` as a basic inverse, mostly useful
  for testing.

Not yet supported (all fail with a clear error, not a silent wrong
answer):
- Binary kernels (SPK, PCK, CK, DSK, ...) -- these use NAIF's DAF/DAS
  binary formats and are a separate, larger effort.
- Spacecraft clock (SCLK) strings, day-of-year time strings, and the
  TDT time system.
- UTC epochs before 1972-JAN-1 (where the leapseconds table starts).

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
// no kernel needs to be loaded for these.
str2et('2000-01-01T12:00:00 TDB');
//=> 0
```

### Supported `str2et` input formats

```
2026-08-11T12:00:00.500      ISO calendar (UTC by default)
2026-08-11 12:00:00
2026-08-11
2026 AUG 11 12:00:00         SPICE-style calendar, any field order
11 AUG 2026 12:00:00
AUG 11, 2026 12:00:00
JD 2451545.0                 Julian date
2026-08-11T12:00:00 TDB      explicit time system suffix (UTC/TDB/ET)
```

A calendar string needs either an ISO `YYYY-MM-DD` date or a month
name -- three numeric fields with no month name (e.g. `01 02 03`) is
rejected as ambiguous rather than guessed at.

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
ET = UTC + DELTA_AT + DELTA_T_A + K * sin(E)
E  = M0 + M1 * T + EB * sin(M0 + M1 * T)
```

- `DELTA_AT` is the whole-second TAI-UTC leap second count in effect
  at the given UTC instant, looked up from the `DELTET/DELTA_AT`
  table the LSK loads into the pool.
- `DELTA_T_A`, `K`, `EB`, and `M` come from the LSK's `DELTET/*`
  variables and model the (sub-millisecond) periodic difference
  between Terrestrial Time and Barycentric Dynamical Time.

See `src/time/deltet.js` and `src/time/calendar.js` for the full
implementation and comments.

## Development

```sh
npm test        # runs the test suite (node's built-in test runner)
node examples/basic.mjs
```

## Acknowledgements

The [NAIF SPICE Toolkit](https://naif.jpl.nasa.gov/naif/toolkit.html)
and its [unofficial GitHub mirror](https://github.com/OpenSpace/Spice)
were used as the behavioral reference. `kernels/naif0012.tls` is
NAIF's own publicly distributed leapseconds kernel, included here as a
test fixture and usage example.
