# Kernels

A handful of text kernels are checked in here, because they're small
and almost everything needs them:

| file | what it's for |
| --- | --- |
| `naif0012.tls` | Leapseconds (LSK) -- `str2et()`, `et2utc()` |
| `pck00011.tpc` | Text PCK -- `BODY<id>_RADII`, `IAU_<BODY>` orientation constants |
| `gm_de440.tpc` | `BODY<id>_GM` mass parameters (km^3/s^2) -- the browser demo's per-body orbital-period sizing (`estimateOrbitalPeriodSec()`, via the vis-viva equation) |
| `basic.tm` | A tiny meta-kernel used by `examples/basic.mjs` |

Everything else -- the binary SPK ephemerides -- is fetched from NAIF on
demand. `sources.mjs` is the catalogue: URLs, exact sizes, and the full
list of bodies each file provides. Those fields were read off the *real*
files (`node scripts/inspect-spk.mjs --check` re-verifies them against
the live server), not transcribed from documentation.

## Why nothing binary is checked in

The ten SPKs in the catalogue total **7.4 GB**:

| kernel | size | contents |
| --- | --- | --- |
| `de440s` | 32.7 MB | Sun, planets, barycenters, 1849-2150 |
| `de440` | 119.8 MB | Sun, planets, barycenters, ~1550-2650 |
| `mar099` | 1.23 GB | Phobos, Deimos |
| `jup365` | 1.14 GB | Io, Europa, Ganymede, Callisto + 4 inner moons |
| `sat480` | 12.6 MB | Saturn itself + one small body (see caveat below) |
| `ura184-1` | 2.06 GB | Uranus inner small moons (Cordelia..Portia) |
| `ura184-2` | 2.06 GB | Uranus: Rosalind, Belinda, Puck, Perdita, Mab, Cupid |
| `ura184-3` | 386.9 MB | Uranus major moons (Ariel, Umbriel, Titania, Oberon, Miranda) |
| `nep105` | 210.5 MB | Nereid + Neptune (**not** Triton) |
| `plu060` | 135.2 MB | Charon, Nix, Hydra, Kerberos, Styx, Pluto |

A single body over a single month touches well under a megabyte of any
of them. So the default path fetches byte ranges, not files.

## Getting kernel data

**Preferred -- no download at all:**

```sh
npm run serve-example
```

Serves the repo at <http://localhost:8080> *and* proxies every kernel in
the catalogue at `/kernels/remote/<file>.bsp`, honouring HTTP Range
requests and caching what it fetches into `cache/` as a sparse file. The
browser demo detects this automatically and offers one-click loading.
Measured on the real `de440s.bsp` for the demo's own startup query: 23
ranged reads, **1.47 MB fetched of 32.7 MB**, and a second run fetches
nothing at all.

Because it's same-origin, this also sidesteps the fact that
`naif.jpl.nasa.gov` sends no `Access-Control-Allow-Origin` header --
a browser can never `fetch()` it cross-origin directly.

**When you want a whole file** (offline use, or handing it to spiceypy
or CSPICE, which can't do ranged reads):

```sh
npm run download-spk -- --list        # what's available / already here
npm run download-spk -- de440s        # one kernel
npm run download-spk -- --group satellite --yes
```

Downloads land in `cache/` too, and resume if interrupted.

## `cache/`

Gitignored. Holds both whole downloads and the proxy's sparse
range-cache (each `<file>.bsp` paired with a `<file>.bsp.blocks` bitmap
recording which blocks are real). Sparse files mean the apparent size is
the full kernel size while actual disk use is only what was fetched --
in one measured session, 4.95 GB of apparent kernels cost **22 MB** of
real disk. Delete the directory any time; it all refetches on demand.

## Caveats found by reading the real files

- **`sat480` has no classic Saturnian moons.** Despite the name it
  carries only Saturn itself and one unnamed small body (65304), whose
  only segment is **type 17**, which spiceJS does not evaluate yet. For
  Titan/Enceladus/etc. you want a different `sat*.bsp`.
- **`nep105` has Nereid (802), not Triton (801).**
- **Each satellite SPK is self-sufficient for chaining.** They all carry
  their own copies of the Sun, Earth, EMB and their planet's barycenter
  relative to the SSB, so you can get a moon's state relative to the SSB
  from that one file, without `de440` loaded alongside it.
