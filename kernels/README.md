# Kernels

A handful of small text kernels are checked in here, for tests, `crossval/`,
`npm run perf`, and the runnable examples in `examples/` — they're tiny and
almost everything needs them:

| file | what it's for |
| --- | --- |
| `naif0012.tls` | Leapseconds (LSK) -- `str2et()`, `et2utc()` |
| `pck00011.tpc` | Text PCK -- `BODY<id>_RADII`, `IAU_<BODY>` orientation constants |
| `gm_de440.tpc` | `BODY<id>_GM` mass parameters (km^3/s^2) |
| `basic.tm` | A tiny meta-kernel used by `examples/basic.mjs` |

No binary SPK/PCK/CK kernels are checked in here — this library reads
whatever bytes you hand it (`furnsh()`/`load()`), and doesn't ship or
fetch any real ephemeris data of its own. For a curated catalogue of
real NAIF kernels, a range-caching local proxy, and tooling to download
or inspect them, see [orbit-viewer](https://github.com/stevenstetzler/orbit-viewer)
(built on this library), which owns that concern.
