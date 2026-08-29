# Install, run, and deploy

Three separate things live in this repo, and "deploying spiceJS" means a
different amount of work depending on which one you want:

1. **The library itself** (`src/`) -- import it into your own Node or
   browser project. No server of any kind involved.
2. **The example visualization site** (`examples/browser-demo/`, the
   curated `/solar-system/`, `/<body>/`, `/close-approach/` pages) --
   `npm run serve-example` locally, or a small always-on Node process if
   you want other people to reach it.
3. **The kernel/Horizons proxy** (`scripts/serve-example.mjs`) -- the one
   piece of the second item above that's actually a server, not just
   static files, and the one thing worth thinking about before putting
   it somewhere other people can hit.

This document covers all three, plus (at the end) a real, live-measured
estimate of how much data each of the visualization site's views pulls
over the network per visit -- see "Bandwidth per view" below.

## Requirements

- **Node >= 18** (`package.json`'s `engines` field) -- that's the whole
  runtime requirement for everything in this repo. `src/` has **zero
  runtime dependencies** (`package.json` lists none); the one
  `devDependency`, `fake-indexeddb`, is only used by
  `test/cache.test.js` to exercise the browser `IndexedDB` cache path
  under Node.
- No build step, anywhere. `src/`, `examples/`, and the curated pages are
  all plain ES modules, loaded directly by Node's `import` or the
  browser's native `<script type="module">`/import maps -- nothing here
  needs webpack/vite/esbuild/etc. to run. (You'd still want a bundler if
  you're pulling spiceJS into an app that already has one -- see
  "Using the library in your own project" below.)
- `npm install` only matters for that one test-only dependency and for
  `pip install spiceypy` if you want to run `npm run crossval`/`npm run
  perf` (see README's "Validating against real CSPICE" and
  `perf/README.md`) -- neither is needed to use the library or run the
  demo site.

```sh
git clone https://github.com/stevenstetzler/spiceJS.git
cd spiceJS
npm install   # only pulls in fake-indexeddb, for the test suite
npm test      # confirms the clone is healthy -- see "Verifying an install" below
```

## 1. Using the library in your own project

Not published to npm yet, so point at the clone directly (a `file:`
dependency, a git submodule, or just vendoring `src/`):

```js
import { furnsh, str2et, spkezr } from './src/index.js'; // Node
```

```js
import { load, spkezr } from 'spicejs/browser'; // Browser, via your own bundler
```

`package.json`'s `exports` map resolves the bare `spicejs` specifier to
`src/browser.js` automatically for any bundler that respects the
`"browser"` condition, so you don't have to hand-write the `/browser`
suffix everywhere -- see `docs/browser-support.md` for the full story on
what's Node-only (`furnsh`, `kclear`, anything touching `node:fs`) versus
what runs in both. No server, no deployment -- this is just an `npm`
dependency (once published) or a vendored copy either way. See the root
[`README.md`](README.md)'s own "Install" section and
`examples/basic.mjs`/`examples/spk.mjs`/`examples/pck.mjs` for runnable
examples, and [`kernels/README.md`](kernels/README.md) for how to get
real kernel data into it (`npm run download-spk`, or `openRemoteSpk()`
against your own CORS-enabled host).

## 2. Running the example visualization site, locally

```sh
npm run serve-example                 # http://localhost:8080
npm run serve-example -- --port 9000  # a different port
```

One Node process, `scripts/serve-example.mjs`, does two jobs at once:

- **Serves the repo as static files** -- `examples/browser-demo/`, the
  curated `/solar-system/`, `/solar-system/trajectory/`, `/<body>/`,
  `/<body>/trajectory/`, and `/close-approach/` pages, and everything
  under `examples/shared/`/`src/` those pages `import` directly as ES
  modules. No server-side templating or rendering -- what you fetch is
  what ships to the browser.
- **Proxies three real JPL/NAIF APIs**, same-origin, because none of
  them send an `Access-Control-Allow-Origin` header (confirmed live,
  see `docs/lazy-loading.md` and `examples/browser-demo/README.md`'s own
  "Why not just `fetch()` it by URL?") -- a browser can never read the
  response to a cross-origin `fetch()` against any of them, full stop,
  no matter how the request itself is made:
  - `GET /kernels/remote/<file>.bsp` (any `Range` header) -- proxies
    `naif.jpl.nasa.gov`'s real SPK files, block-cached on disk under
    `kernels/cache/` (see `docs/lazy-loading.md`'s "Serving kernels
    through a range-caching proxy" for the exact mechanics).
  - `GET /horizons/resolve?sstr=...` and `GET
    /horizons/spk?spkid=...&start=...&stop=...` -- proxy JPL's
    Small-Body Database and Horizons APIs (`scripts/horizonsSpk.mjs`),
    whole-SPK-cached per `spkid` under `kernels/cache/horizons/`.
  - `GET /close-approach/data` -- proxies JPL's Close-Approach Data API
    (`scripts/closeApproach.mjs`), cached in memory for one hour
    (`scripts/serve-example.mjs`'s own `CLOSE_APPROACH_CACHE_TTL_MS`).

**This means the interactive experience genuinely needs this server** --
it isn't optional plumbing you could drop for a plain static host. Serve
just the static files (GitHub Pages, a CDN, `python3 -m http.server`)
and every page still loads, but "load `de440s` through the proxy,"
"Fetch from JPL Horizons," and the `/close-approach/` table all fail
with a clear CORS error, exactly like the demo's own "Try loading it
directly" button demonstrates on purpose. The one thing that still works
under plain static hosting is loading your *own already-downloaded*
`.bsp` file through the file picker (`examples/browser-demo/`'s "Add a
custom kernel") -- that's local `File.slice()` reads, no network
involved at all.

## 3. Deploying the example site for other people

Same one process, just left running somewhere reachable, plus a few
things worth deciding up front:

- **Put a reverse proxy in front of it** (nginx, Caddy, a platform's own
  TLS-terminating load balancer) for HTTPS and a real domain --
  `scripts/serve-example.mjs` itself speaks plain HTTP and binds every
  interface on whatever port you give it (`server.listen(opts.port,
  ...)`, no host argument), so it's already reverse-proxy-friendly; it
  just doesn't do TLS itself.
- **Deployable under a subpath** (e.g. `https://example.com/spiceJS/`),
  not just at a domain's own root. Every page/module resolves its own
  assets and API calls with paths *relative* to itself (either hand-
  counted `../` in a page's own inline script, or an `import.meta.url`-
  anchored `SITE_ROOT` in a module shared across pages at different
  depths, e.g. `examples/shared/horizonsClient.js`/`kernelSession.js`)
  rather than root-absolute ones -- so mounting this behind a proxy that
  **strips the subpath prefix** before forwarding (the server itself
  needs no prefix awareness at all; its own routing keeps matching
  exactly the paths it always has) just works:
  ```nginx
  location /spiceJS/ {
      proxy_pass http://127.0.0.1:8080/;   # trailing slash strips the /spiceJS/ prefix
      proxy_set_header Host $host;
  }
  ```
  The two server-emitted redirects (a directory request missing its
  trailing slash) use a *relative* `Location` header for the same
  reason -- resolved by the browser against the original request URI,
  so it comes back through the stripping proxy correctly without the
  server needing to know the prefix exists.
- **Give it persistent disk for `kernels/cache/`** if you want the
  caching to actually pay off across restarts -- it isn't required
  (an empty `kernels/cache/` just re-fetches from NAIF/JPL on demand,
  exactly like a fresh clone), but without it every deploy/restart
  throws away everything every previous visitor's traffic already
  pulled down. Sizing: the cache is sparse, so its *apparent* size can
  look alarming (a `.bsp` cache file is the full remote kernel's length)
  while its *real* disk usage is only whatever byte ranges were actually
  touched -- one measured session in `kernels/README.md`: **4.95 GB of
  apparent kernels, 22 MB of real disk**. Even a deployment that gets
  every curated page visited (all ten body pages, both trajectory
  variants, `/close-approach/`) stays well under a gigabyte of real
  cache, per the per-view numbers below -- nowhere near the 8 GB the
  full kernel catalogue would cost if downloaded whole.
- **Outbound HTTPS to three hosts**, from the server (not from
  visitors' browsers -- that's the whole point of the proxy):
  `naif.jpl.nasa.gov`, `ssd-api.jpl.nasa.gov`, `ssd.jpl.nasa.gov`. If
  your hosting environment restricts outbound traffic by allowlist,
  these three need to be on it or every proxied feature fails (the
  static pages themselves still load fine either way).
- **three.js loads from a CDN** (unpkg, pinned to `0.169.0`) via an
  import map in every visualization page -- needs visitors' *browsers*
  to reach `unpkg.com` (unrelated to the server's own outbound
  requirements above). For a fully offline/air-gapped deployment, vendor
  a local copy and edit each page's import map -- `examples/browser-demo/README.md`'s
  "Notes" section flags this same tradeoff.
- **No built-in auth or rate limiting.** Every visitor's page can
  trigger a real request to NAIF/SBDB/Horizons on your server's behalf
  (a kernel range read, an SBDB resolve, a Horizons SPK generation, a
  close-approach query) -- all cheap individually and all
  cached/deduplicated server-side (see the bandwidth numbers below), but
  there's nothing here stopping a much higher request volume than a
  normal visitor would generate. Worth putting your own rate limiting in
  front (the reverse proxy layer above is a natural place for it) if
  this is going to be reachable by the general public rather than a
  known/internal audience -- these are public JPL/NAIF services, not
  infrastructure you control, and being a considerate proxy in front of
  them is worth the small extra setup.
- **No `Cache-Control` headers are set on any proxied response** -- the
  server-side disk/memory caches above only save the *server<->NAIF/JPL*
  leg. The *browser<->server* leg still happens in full on every single
  page load, even a reload by the same visitor a minute later (nothing
  here tells the browser it's allowed to reuse what it already fetched).
  That's exactly what the "Bandwidth per view" numbers below measure --
  they're real per-*visit* costs, not one-time site-wide costs.
- **Memory footprint is modest on the server itself** -- it streams
  bytes and caches to disk/memory, not large in-memory buffers per
  request. The one real memory cost of `openRemoteSpk()`'s design (a
  single, mostly-zero, `fileLength`-sized buffer per opened kernel --
  see `docs/lazy-loading.md`'s Phase 1 notes) happens inside each
  **visitor's own browser tab**, not on your server -- e.g. opening
  `jup365.bsp` allocates ~1.14 GB of (mostly untouched) buffer space
  client-side. Not something the server hosting this needs to plan
  around, but worth knowing if you're wondering where a visitor's own
  tab memory is going.

## Verifying an install

```sh
npm test                       # node's built-in test runner -- no network, no external deps
npm run crossval               # optional: needs `pip install spiceypy`, see crossval/README.md
npm run perf                   # optional: needs spiceypy + real network access to naif.jpl.nasa.gov
npm run inspect-spk -- --check # optional: re-verifies kernels/sources.mjs against the live NAIF files
```

Only `npm test` is expected to work with no network access and no extra
setup -- the other three are all explicitly **not** part of `npm test`
for exactly that reason (see `crossval/README.md`/`perf/README.md`).

## Bandwidth per view

Every number below is **real and live-measured**, not calculated from
kernel sizes on paper: a small script drove the exact same
`examples/shared/` functions each real page calls (`prefetchBodyProbe()`,
`ensureBodyCoverage()`, `trajectoryWindowForBody()`, ...) directly
against the real, live `naif.jpl.nasa.gov`/`ssd-api.jpl.nasa.gov`/
`ssd.jpl.nasa.gov` endpoints, with a fresh, empty cache each time (a
true first-time visitor, nothing pre-warmed) -- then summed the exact
byte ranges `RemoteFile` (see `src/lazy/remoteFile.js`) actually
populated. That's the same 64 KiB block granularity `scripts/serve-example.mjs`'s
own proxy uses (confirmed in `docs/lazy-loading.md`'s own block-size
tuning table), so these numbers predict the real **browser&harr;server**
transfer for any visitor, and, for literally the first visitor to a
freshly deployed, empty-cache server, the **server&harr;NAIF/JPL**
transfer too (every visitor after that reuses the on-disk/in-memory
cache for that leg -- see "No `Cache-Control` headers" above for why the
browser&harr;server leg alone still repeats on every visit regardless).

Every page's session is fixed to the **1900-2100** window (`str2et('1900-01-01T00:00:00')`
to `str2et('2100-01-01T00:00:00')`, hardcoded in each page -- see
`modules.md`), against the real `de440s.bsp` (32.7 MB, covers
1849-2150) for the ten built-in bodies, plus the relevant satellite
kernel from `kernels/sources.mjs` for a `/<body>/` page with known
moons. "Reference epoch" defaults to *now*, clamped into that range.

| View | What loads by default | Requests | Bytes |
| --- | --- | --- | --- |
| `/solar-system/` (Ellipse mode) | Single-point probe, all 10 bodies (osculating ellipse needs one real state + `GM`, not a sampled trajectory) | 23 | **1.47 MB** |
| `/solar-system/trajectory/` | Real sampled trajectory for all 9 non-Sun bodies over each one's own sidereal period (Pluto's ~249-year period alone clamps to nearly the full 1900-2100 window), plus the Sun's own coverage widened to the union of all of them | 58 | **3.76 MB** |
| `/sun/` (and its `/trajectory/` variant -- no known satellites) | Sun only | 3 | **0.20 MB** |
| `/mercury/` (+ `/trajectory/` -- no known satellites) | Mercury only | 4 | **0.22 MB** |
| `/venus/` (+ `/trajectory/` -- no known satellites) | Venus only | 4 | **0.22 MB** |
| `/earth/` (+ `/trajectory/`) | Earth + the Moon (already inside `de440s`, no extra kernel) | 7 | **0.42 MB** |
| `/mars/` (+ `/trajectory/`) | Mars + Phobos + Deimos (`mar099.bsp`, 1.23 GB kernel -- only a few hundred KB of it ever touched) | 11 | **0.72 MB** |
| `/jupiter/` (+ `/trajectory/`) | Jupiter + 8 moons (`jup365.bsp`, 1.14 GB kernel) | 23 | **1.51 MB** |
| `/saturn/` (+ `/trajectory/`) | Saturn + 13 moons (`sat441.bsp`, 662 MB kernel) | 33 | **2.16 MB** |
| `/uranus/` (+ `/trajectory/`) | Uranus + 5 major moons (`ura184_part-3.bsp`, 387 MB kernel) | 18 | **1.18 MB** |
| `/neptune/` | Neptune + Nereid (`nep105.bsp`, 211 MB kernel -- no Triton, see `kernels/README.md`) | 9 | **0.59 MB** |
| `/neptune/trajectory/` | Same, plus Nereid's real ~360-day period window (long enough to cross a fetch-block boundary the plain page's single-point probe didn't need) | 12 | **0.79 MB** |
| `/pluto/` (+ `/trajectory/`) | Pluto + Charon, Nix, Hydra, Kerberos, Styx (`plu060.bsp`, 135 MB kernel) | 17 | **1.11 MB** |
| `/close-approach/`, initial load | Earth + Moon (`de440s` only) + a probed-but-never-shown Sun stub (`close-approach/index.html`'s `demo.sunStub` -- a Horizons SPK is always Sun-centered, so the Sun has to be a known chain link even though this page never shows it) | 9 | **0.55 MB** |
| &rarr; `+` `/close-approach/data` (the sortable table itself) | JPL's real Close-Approach Data API response, server-cached 1 hour | 1 | **0.61 MB** |
| &rarr; `+` selecting one close-approach row | SBDB resolve (a few KB) + a Horizons SPK for that object over `cd &plusmn; 1 day` only (measured, a real object: 70 KB decoded) + a couple more `de440s` chaining blocks | a few | **&asymp; 0.15-0.35 MB** |

For every `/<body>/trajectory/` page except Neptune's, the trajectory
variant costs **exactly the same** as the plain page -- a real,
measured finding, not an oversight: every satellite's own real orbital
period (hours to ~80 days, even for Saturn's distant Iapetus) already
falls entirely inside the 64 KiB fetch block the plain page's
single-point probe already pulled in, so widening the window to a full
orbit needs no additional network request at all. Only Nereid's unusually
long ~360-day period (Neptune's sole visible moon here) is wide enough to
need a bit more.

**Two features are user-triggered, not part of any default page load,
and can cost meaningfully more:**

- **"Fetch from JPL Horizons"** (`/solar-system/`'s search box, and
  `examples/browser-demo/`), which always fetches the full 1900-2100
  range regardless of the object -- measured live for 1 Ceres: **3.65 MB**
  decoded SPK, **4.99 MB** over the wire (Horizons' JSON+base64
  response format costs a real ~37% overhead over the raw bytes). This
  varies a lot by object (orbital period, eccentricity, and how much
  data Horizons needs to generate for the requested span all matter) --
  Ceres is one real data point, not a hard ceiling.
- **The uncurated `examples/browser-demo/`**, whose own startup probe
  (all 10 bodies, single-point, same pattern as `/solar-system/`'s
  Ellipse mode) is already independently measured in
  `kernels/README.md`: **23 ranged reads, 1.47 MB** of `de440s.bsp`'s
  32.7 MB -- matching the `/solar-system/` figure above almost exactly,
  since it's the same underlying probe. Anything past that (Command+Click
  into a satellite system, switching to Trajectory mode, uploading or
  fetching a custom kernel) adds its own cost on top, following the same
  per-body/per-satellite-kernel numbers in the table above.

Not counted in any of these numbers: the page's own HTML/CSS/JS and the
three.js library itself (a few hundred KB from the `unpkg` CDN, shared
across every page, and ordinarily cached by the browser like any other
script -- unlike the kernel/Horizons bytes above, which currently aren't,
per "No `Cache-Control` headers" above). Those are page-weight, not
kernel-data bandwidth, and don't scale with which bodies or date range a
visit actually touches -- which is what this table is about.
