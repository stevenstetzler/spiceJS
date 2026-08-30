// Minimal usage example: load a leapseconds kernel into the kernel
// pool, then convert a UTC time string to ephemeris time.
//
// Run from the repo root with:
//   node examples/basic.mjs

import { furnsh, str2et, et2utc } from '../src/index.js';

furnsh(new URL('../kernels/naif0012.tls', import.meta.url).pathname);

const et = str2et('2026-08-11T12:00:00');
console.log('ET:', et);
console.log('round-trip UTC:', et2utc(et));

// A time system suffix skips the leapseconds correction entirely --
// note the space, not "T": an ISO "T" string rejects any trailing
// label at all (matching real str2et_c exactly; use a space-separated
// calendar string instead, as here, to combine a date with a label).
console.log('TDB passthrough:', str2et('2000-01-01 12:00:00 TDB'));

// "JD" may come before or after the number.
console.log('JD prefix:', str2et('JD 2451545.0 TDB'));
console.log('JD suffix:', str2et('2451545.0 JD TDB'));

// TDT only needs the periodic term, not the leap-second table.
console.log('TDT:', str2et('2000-01-01 12:00:00 TDT'));
