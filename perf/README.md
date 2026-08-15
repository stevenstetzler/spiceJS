# Lazy-loading benchmark: network cost and ephemeris accuracy

Demonstrates `openRemoteSpk()`'s real network-cost reduction and
confirms it's exactly as accurate as the eager (whole-file) path --
against the real, unmodified, NAIF-distributed `de440.bsp`, not a
synthetic fixture. See `docs/lazy-loading.md` for the design this is
built on.

## What it does

For **Earth (399)**, **Moon (301)**, **Jupiter barycenter (5)**, and
**Neptune barycenter (8)**, each relative to the Solar System
Barycenter, over **1 day, 1 month, 1 year, 10 years, and the full
de440 time range** (its own actual coverage, discovered from the live
file, not hardcoded): runs an *isolated* `openRemoteSpk()` +
`prefetch()` (a fresh connection, no cache -- the cost of exactly that
one query alone) against the real file over the network, records how
many HTTP requests and bytes that took, evaluates ordinary `spkez()`
at 5 sample epochs across the range, and cross-checks every one
against real CSPICE (`spiceypy`) reading the same file locally.

## Running

```sh
pip install spiceypy
npm run perf
```

This: (1) `benchmark.mjs` downloads the real `de440.bsp` (~114 MB,
cached in `fixtures/` after the first run -- used only as spiceypy's
local reference copy, never read by the lazy loader itself) and runs
every test case, writing `results/lazy-results.json`; (2)
`spiceypy-reference.py` computes real-CSPICE ground truth for the same
cases, writing `results/spiceypy-results.json`; (3) `report.mjs`
compares them, prints a formatted table, writes `results/report.md`,
and exits non-zero if any case's position error exceeds `1e-5` km
(matching `crossval/compare.mjs`'s own tolerance) -- this is a
correctness check, not just a performance demo.

Like `crossval/`, this is **not** part of `npm test` -- it needs
network access and `spiceypy`, and downloads a real 114 MB file.

## What the numbers actually look like

From a real run (see `results/report.md` after running it yourself
for current numbers -- `fixtures/`/`results/` are gitignored, not
checked in):

- **Narrow time windows** (1 day through 10 years): **99.4-99.84%**
  network reduction, fetching a few hundred KB instead of the full
  119.8 MB file, in 3-5 HTTP requests, matching CSPICE to within
  `1e-6`-`1e-7` km (float64 noise, not a real discrepancy).
- **The full de440 time range** (~1100 years, 1550-2650): still a
  **65-98%** reduction, not zero -- even asking for *every* epoch a
  body has data for only touches the 2-3 segments (of the file's 14)
  actually relevant to that body, not the other planets'/barycenters'
  data. Jupiter/Neptune (single-hop, no Earth-Moon-Barycenter
  indirection, smaller per-record size) save more (~98%) than
  Earth/Moon (~65%, since Earth-Moon system data is stored at a much
  finer 4-day cadence and dominates the file's size).

## Notes

- Each row uses a *fresh* `RemoteFile` with no cache, specifically to
  report the isolated cost of that one query -- a real application
  reusing one `openRemoteSpk()`/cache across many queries (the
  realistic usage pattern) would see structural metadata and any
  overlapping byte ranges shared across calls, so cumulative savings
  in practice are at least this good, typically better.
- If `fetch()` in your Node environment doesn't seem to reach
  `naif.jpl.nasa.gov` at all (hangs or times out with no error, rather
  than a normal HTTP response), check whether your environment routes
  outbound HTTPS through a proxy that Node's built-in `fetch()` needs
  explicitly opted into (e.g. `NODE_USE_ENV_PROXY=1` on Node ≥ 22.21) --
  this is an environment/network-configuration detail, not something
  `openRemoteSpk()` itself does anything unusual with (it just calls
  `fetch()`, same as `load()` does).
