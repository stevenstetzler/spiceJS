# Scoping lazy/range-based kernel loading

**Status: Phases 1, 2, 3, and 5 are implemented** (`src/lazy/`:
`remoteFile.js`, `byteRange.js`, `prefetch.js`, `openRemoteSpk.js`,
`pckPrefetch.js`, `openRemotePck.js`, plus `daf.js`'s `checkRange`
hook) -- exported as `openRemoteSpk`/`openRemotePck`/`openRemoteFile`
from both `src/index.js` and `src/browser.js`. Phase 4 (types
5/9/13/21's large-`N`, on-disk-directory case) remains a
scoped-but-unimplemented placeholder, as planned -- it needs its own
source-verification pass first. Re-ran this document's `de440s.bsp` worked example through the
*actual* implementation (not hand-rolled) after building it: **5 real
HTTP requests, 285,696 bytes (0.87% of the 32,726,016-byte file)**,
result matching `spiceypy` to full double precision. See "What actually
shipped" below the phase-by-phase plan for the handful of things that
came out slightly differently than originally sketched here, and why.
A broader, reproducible benchmark (`npm run perf`, see `perf/README.md`)
covers Earth/Moon/Jupiter/Neptune over 1 day through the full de440
range (~1100 years) against the real `de440.bsp`: 99.4-99.84% network
reduction for narrow windows, 65-98% even for the full time range
(only the 2-3 of the file's 14 segments relevant to a given body are
ever touched), every sampled state within `1e-6`-`1e-7` km of real
CSPICE (float64 noise, not a discrepancy). And it's been verified live
in an actual browser, not just Node: `examples/browser-demo/` (a
three.js visualization driven entirely by `openRemoteSpk()` +
`File.slice()`) was run in real headless Chromium against the real
`de440.bsp`, with zero console errors and all eleven plotted bodies at
their correct positions (25 range reads, 1.64 MB touched out of 119.8 MB).

This started as a scoping document for `docs/browser-support.md` §3.6
(block-aligned lazy/range loading). It works through the concrete
example the design was motivated by: lazily loading `de440.bsp` and
calling `spkez` for Earth over a time range `[t1, t2]`, fetching only
the bytes that query actually needs.

## The numbers, verified against the real file

Everything below was checked against the real, NAIF-distributed
`de440s.bsp` (32,726,016 bytes) via `curl` range requests and spiceJS's
own (already-DataView-based, unmodified) `daf.js`/`spk.js` -- not
estimated from memory.

**Structural layout.** `de440s.bsp`'s file record has `FWARD = BWARD =
62` -- there's a ~62 KB descriptive-text comment area between the file
record and the first (and, here, only) summary record, which the
file record's `FWARD` field points straight past. That one summary
record holds all 14 of the file's segments (well under the 25-per-record
ceiling for SPK's `ND=2,NI=6` shape):

```
target=1   center=0 type=2   (Mercury rel SSB)
target=2   center=0 type=2   (Venus rel SSB)
target=3   center=0 type=2   (EMB rel SSB)
target=4   center=0 type=2   (Mars rel SSB)
target=5-9 center=0 type=2   (Jupiter..Pluto rel SSB)
target=10  center=0 type=2   (Sun rel SSB)
target=301 center=3 type=2   (Moon rel EMB)
target=399 center=3 type=2   (Earth rel EMB)
target=199 center=1 type=2   (Mercury rel Mercury Barycenter)
target=299 center=2 type=2   (Venus rel Venus Barycenter)
```

**The two segments `spkez(399, 0, ...)` actually chains through**
(Earth has no direct SSB segment -- it's stored relative to the
Earth-Moon Barycenter, which is itself relative to the SSB):

| segment | `startAddr`/`endAddr` (1-based DAF words) | `INIT` | `INTLEN` | `RSIZE` | `N` |
|---|---|---|---|---|---|
| Earth(399) rel EMB(3) | 2967309 / 4090712 | -4734072000 | 345600 s (4 days) | 41 words (328 B) | 27400 |
| EMB(3) rel SSB(0) | 830073 / 1110926 | -4734072000 | 1382400 s (16 days) | 41 words (328 B) | 6850 |

(`INIT`/`INTLEN`/`RSIZE`/`N` are each segment's own epilog -- the last
4 words of its data, read fresh by `chebyshevRecord.js`'s
`readEpilog()` on every call, never trusted from anywhere else. That
matters for the plan below: the epilog is itself something that has to
be fetched, not just the record data.)

**For a 1-year query window** (`t2 - t1 = 31,536,000` s), the record
index range each segment's fixed-interval addressing touches is pure
arithmetic (`recno = floor((et - INIT) / INTLEN)`, clamped to
`[0, N-1]`) -- no data-dependent lookup needed:

- Earth(399) rel EMB(3): 92 records × 328 B = **30,176 B** (≈29.5 KB)
- EMB(3) rel SSB(0): ~24 records × 328 B = **~7,872 B** (≈7.7 KB)

Plus structural overhead: file record (1024 B) + one summary record
(1024 B) + two 32-byte epilogs (64 B) ≈ **2,112 B**.

**Total: ≈40 KB, against a 32,726,016-byte file -- a ~800x reduction**
for this one file. The absolute byte count doesn't grow with the
file's total time span (only with the query window and the segment's
own interval/record size), so against the real `de440.bsp` (~114 MB,
same per-segment interval choices) the reduction would be roughly
2,500-3,000x for the same 1-year query.

**This was proven end to end, not just estimated:** fetched exactly
those 30,208 bytes (Earth/EMB records + epilog) for the real file via
`curl -r`, built a `Uint8Array` the size of the *addressed* span with
everything zero except those two fetched ranges placed at their real
absolute byte offsets, and called `spk.js`'s existing, **completely
unmodified** `evaluateSegment()` on it directly. Result matched real
CSPICE (`spiceypy.spkgeo(399, et, 'J2000', 3)`, run against the fully
downloaded file) to full double precision:

```
sparse-buffer result:  [620.982, 4220.503, 2314.458, -0.011854, 0.001015, 0.000296]
spiceypy (real CSPICE): [620.9817879173941, 4220.503186952149, 2314.458091649403,
                          -0.01185400196988472, 0.0010146767378624668, 0.00029577380085841554]
```

That's the single most important architectural finding here: **the
existing synchronous reader (`daf.js`/`spk.js`/`chebyshevRecord.js`)
needs zero changes** to work against a lazily-fetched file, as long as
whatever bytes it actually touches are present at their correct
absolute offsets. Lazy loading is a problem of *deciding which bytes
to fetch and when*, layered entirely above the existing reader -- not
a problem of rewriting the reader.

## Two architectures, and why one of them is right

**Design A -- prefetch, then reuse today's synchronous reader
unchanged.** Compute the byte ranges a query needs (as above), fetch
them all in one async step into a sparse buffer, then call the
existing `spkez`/`evaluateSegment`/etc. exactly as they are today,
synchronously. This is what the proof of concept above does by hand.

**Design B -- make the whole reader asynchronous**, threading `await`
through `daf.js`, `chebyshevRecord.js`, `interpolatedRecord.js`,
`spk.js`, `pck.js`, all the way up through `spkState`/`spkez`/
`spkezr`/`evaluateSegment`, with every individual word-range read
doing its own cache-check-then-fetch. No prefetch step needed; any
read pattern is handled automatically, including ones a range-predictor
underestimated.

**Design A is the right call**, for reasons consistent with how
`load()` itself was built:

- It leaves `spk.js`/`pck.js`/`chebyshevRecord.js`/
  `interpolatedRecord.js` completely untouched, and needs only one
  small, purely additive, opt-in hook in `daf.js` (see Phase 1 below
  for the precise shape -- a buffer optionally carries a `.checkRange`
  method, discovered and consulted only when present, so every
  existing plain `Buffer`/`Uint8Array` caller is unaffected) -- no risk
  to the 180-plus tests and 619 crossval cases already validating that
  code, and no need to re-earn that confidence for an async rewrite of
  the same logic.
- `spkState`/`spkez`/`spkezr` stay synchronous, exactly as documented
  today -- no breaking change, no parallel async twins of the entire
  public query API (unlike `load()`, which really did need to be async
  because fetching *is* the operation; here, evaluating a Chebyshev
  polynomial from bytes already in hand has no reason to be async).
- Design B's generality (handling any read pattern automatically) is
  solving a problem Design A doesn't actually have for the segment
  types that matter most (2/3/8/12 -- see below): their record
  addressing is pure arithmetic, so the "what bytes will this touch"
  question has an exact, cheap, computable answer *before* fetching
  anything. Design B would be paying a much bigger implementation and
  maintenance cost to handle a case (unpredictable read patterns) that
  mostly doesn't arise here.

Design B is worth reconsidering only if real-world usage turns up
query patterns Design A's range-prediction genuinely can't anticipate
well (see Phase 1's `src/daf.js` `checkRange` hook below for how
Design A degrades in that case in the meantime -- a clear, catchable
error, not silent wrong data).

## What "compute the byte ranges" takes, per segment type

- **Types 2/3 (Chebyshev)**: exactly what the proof of concept did --
  read the segment's own 4-word epilog (`INIT`/`INTLEN`/`RSIZE`/`N`,
  32 bytes), then `recno = floor((et - INIT) / INTLEN)` is pure
  arithmetic for any `et` in the query window. This is the case that
  covers `de440`/`de440s` and the vast majority of publicly
  distributed planetary/lunar kernels -- the highest-value, lowest-risk
  first slice to build.
- **Types 8/12 (Lagrange/Hermite, equal step)**: same complexity class
  -- read the epilog (`begin`/`step`/`degree`/`N`, also 4 words), then
  the touched window's record-index range is arithmetic from those,
  same as 2/3. Cheap to add once 2/3 works.
- **Types 9/13/5 (Lagrange/Hermite/two-body, unequal step)**:
  genuinely harder, because window/bracket selection is *data-
  dependent* -- it needs the actual epoch values, not just a formula,
  since they aren't evenly spaced. Two sub-cases:
  - For a kernel with a modest epoch count (`N` in the thousands --
    common for most real kernels of this type), just fetch the *whole*
    epoch array (`N` doubles -- e.g. `N=6850` is only ~55 KB) and
    binary-search it locally. Simple, and still a huge reduction
    against a large file.
  - For a genuinely huge `N` (hundreds of thousands to millions of
    epochs -- e.g. a long, high-cadence spacecraft trajectory kernel),
    fetching the whole epoch array stops being cheap. Real SPK files
    of this type carry an on-disk "directory" (one entry per 100
    epochs) specifically so a reader can binary-search *that* first,
    narrow to a ~100-epoch neighborhood, and fetch only the epoch
    array's local chunk plus the matching states. **spiceJS's own
    reader currently skips this directory entirely** (see
    `interpolatedRecord.js`'s doc comment -- `readUnequalStepEpochs()`
    always reads the full epoch array, and the test-only writer caps
    synthetic segments at `N <= 100` specifically so it never has to
    write one). Making this case properly scalable means implementing
    directory reading for the first time -- new capability, not just
    "make the existing reader lazy-compatible."
- **PCK** shares the same underlying primitives (`daf.js`,
  `chebyshevRecord.js`) for its own type 2/3 binary segments (body
  orientation), so type 2/3 lazy loading covers `ref`-driven
  body-fixed-frame lookups the same way, with no separate design
  needed -- just wiring `pck.js`'s segment descriptors through the
  same prefetch step.

## Implementation plan, by phase

Each phase below is independently shippable and independently tested.
Phase 1 builds essentially all of the shared machinery; phases 2-5
mostly add one more case to a couple of dispatch functions.

### Phase 1 -- types 2/3 (Chebyshev): the foundation ✅ implemented

This is the one that delivers the motivating `de440`/`de440s` scenario
in full, and everything later reuses what gets built here.

*(The pseudocode/design below is what was planned before writing any
code, kept as-is for the reasoning. A few specifics changed once
actually built and tested -- notably the `checkRange` mechanism, and
`byteRangeForQuery()`'s own shape -- see "What actually shipped" at
the end of this document for what's different in the real
`src/lazy/*.js`/`src/daf.js` and why; the class is `RemoteFile`, not
`RemoteSpkFile`, since it turned out to serve PCK too, once Phase 5
existed.)*

**New: `src/lazy/` (a new directory, alongside the existing `src/math/`
and `src/data/` clusters of related-but-not-top-level-API files).**

- `src/lazy/remoteFile.js` -- `RemoteSpkFile`:
  ```js
  export async function openRemoteFile(url, { cache, blockBytes = 65536, resolveRange } = {}) {
    // resolveRange(url, startByte, endByteExclusive) -> Promise<Uint8Array>,
    // defaulting to a fetch() with a Range header (mirrors load()'s
    // own overridable `resolve` option) -- overridable the same way,
    // for e.g. a Node local-file range reader.
    const fileLength = await headLength(url); // Content-Length via HEAD, or a Range GET's Content-Range total
    return new RemoteSpkFile(url, fileLength, { cache, blockBytes, resolveRange });
  }

  class RemoteSpkFile {
    buffer;           // Uint8Array(fileLength) -- one allocation, mostly zero
    populatedBlocks;  // Set<number> of block indices actually fetched

    async ensureRange(startByte, endByteExclusive) { /* see below */ }
  }
  ```
  `ensureRange()`: compute the touched block indices
  (`floor(startByte/blockBytes)` .. `floor((endByteExclusive-1)/blockBytes)`),
  check `cache` for each missing one before hitting the network,
  coalesce adjacent network-missing blocks into as few Range GETs as
  possible, write fetched bytes into `buffer` at their real offset,
  mark blocks populated, and `cache.put()` them (block-aligned, per
  `docs/browser-support.md` §3.6 -- this supersedes that section's
  whole-file-only cache with the block-aligned one it already
  describes as the right long-term shape).

  The `fileLength`-sized allocation costs real memory (114 MB for the
  full `de440.bsp`) even though almost none of it is ever written.
  That's an accepted tradeoff, not an oversight: it's a one-time,
  mostly-zero allocation, dramatically cheaper than the *network*
  transfer this whole feature exists to avoid. A `Map<blockIndex,
  Uint8Array>`-backed sparse structure is the fallback if that
  allocation turns out to be unacceptable in some target environment,
  at the cost of `daf.js`'s `toDataView()` no longer being able to
  construct one `DataView` directly over a contiguous `ArrayBuffer`
  for a read spanning multiple blocks -- worth landing the simpler
  full-allocation version first and only reaching for the sparse-map
  version if a real memory-budget problem shows up.

- `src/lazy/byteRange.js` -- `byteRangeForQuery(segment, etStart, etEnd)`,
  dispatching on `segment.type` (Phase 1 implements only `case 2: case 3:`).
  For those, given the segment's own epilog (`init`, `intlen`,
  `rsize`, `n` -- read via `readEpilog()`, already exported from
  `chebyshevRecord.js`, reused unchanged):
  ```js
  function chebyshevByteRange(segment, epilog, etStart, etEnd) {
    const recnoStart = clamp(Math.floor((etStart - epilog.init) / epilog.intlen), 0, epilog.recordCount - 1);
    const recnoEnd = clamp(Math.floor((etEnd - epilog.init) / epilog.intlen), 0, epilog.recordCount - 1);
    const wordStart = segment.startAddr + recnoStart * epilog.recordSize;
    const wordEndExclusive = segment.startAddr + (recnoEnd + 1) * epilog.recordSize;
    return { startByte: (wordStart - 1) * 8, endByteExclusive: (wordEndExclusive - 1) * 8 };
  }
  ```
  (This is exactly the arithmetic the proof of concept ran by hand
  against the real file above.)

- `src/lazy/prefetch.js` -- the orchestration:
  ```js
  export async function prefetchSpkQuery(remoteFile, pool, { target, center, etStart, etEnd, lightTimeMargin = 0 }) {
    await remoteFile.ensureRange(0, FILE_RECORD_BYTES);
    const fileRecord = parseFileRecord(remoteFile.buffer);          // unmodified daf.js call
    await remoteFile.ensureRange((fileRecord.fward - 1) * FILE_RECORD_BYTES, fileRecord.bward * FILE_RECORD_BYTES);
    const daf = parseDaf(remoteFile.buffer);                        // unmodified daf.js call

    const chain = findChainSegments(daf.summaries, target, center); // new: generalizes spk.js's chainStateToSsb's
                                                                     // link-walking from "down to the SSB" to
                                                                     // "target down to a specific center"
    for (const segment of chain) {
      const epilogRange = epilogByteRange(segment);                 // segment.endAddr - 3 .. segment.endAddr
      await remoteFile.ensureRange(epilogRange.startByte, epilogRange.endByteExclusive);
      const epilog = readEpilog({ ...segment, buffer: remoteFile.buffer, littleEndian: daf.littleEndian });
      const range = byteRangeForQuery(segment, epilog, etStart - lightTimeMargin, etEnd + lightTimeMargin);
      await remoteFile.ensureRange(range.startByte, range.endByteExclusive);
    }
    pool.addSpkSegments(chain.map((s) => ({ ...s, buffer: remoteFile.buffer, littleEndian: daf.littleEndian })));
  }
  ```
  `lightTimeMargin` matters for `abcorr != 'NONE'`: light-time
  correction queries the target segment at `et ± lightTime`, which can
  land slightly outside `[etStart, etEnd]` (up to ~20-25 minutes for
  outer-planet distances). A caller doing a light-time-corrected query
  should pass a fixed conservative margin (e.g. 30 minutes) -- simpler
  and safer than trying to compute the true light time before knowing
  the position, exactly the chicken-and-egg `spkez` itself already
  resolves by iterating. Central-differencing for velocity
  (`VELOCITY_DERIVATIVE_STEP_S = 1` second, in `spk.js`) is negligible
  and never needs its own margin.

- The public entry point, `src/lazy/openRemoteSpk.js`:
  ```js
  export async function openRemoteSpk(url, options = {}) {
    const remoteFile = await openRemoteFile(url, options);
    const pool = new KernelPool();
    return {
      pool,
      prefetch: (query) => prefetchSpkQuery(remoteFile, pool, query),
    };
  }
  ```
  ```js
  const remote = await openRemoteSpk('https://your-cors-enabled-host/de440.bsp', { cache });
  await remote.prefetch({ target: 399, center: 0, etStart: t1, etEnd: t2, abcorr: 'LT+S' });
  // Ordinary, synchronous, unmodified spkez() from here on:
  const { position, velocity } = spkez(399, 0, someEtBetweenT1AndT2, 'LT+S', null, remote.pool);
  ```

**Modified: `src/daf.js` -- one small, purely additive change, not the
"zero lines" claim above (that claim was imprecise and is corrected
here).** Reads outside a populated range must throw, not silently read
zeros -- a naive zero-padded buffer (as the proof of concept used,
which controlled its own query precisely by hand) would otherwise
silently hand back a plausible-looking wrong answer for anything
touching an unpopulated region, exactly the class of bug this project
has avoided everywhere else. The subtlety: `DataView` reads the raw
`ArrayBuffer` directly, bypassing the `Uint8Array` wrapper entirely --
so there's no way to intercept an out-of-range read by wrapping
`bytes` (a `Proxy` around the `Uint8Array` would never even see a
`DataView.getFloat64()` call). The enforcement point has to be the
`DataView` itself, at `toDataView()`:
```js
function toDataView(bytes, checkRange) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!checkRange) return dv; // every existing call site: unchanged, zero overhead, zero behavior change
  return {
    getInt32: (offset, le) => (checkRange(offset, offset + 4), dv.getInt32(offset, le)),
    getFloat64: (offset, le) => (checkRange(offset, offset + 8), dv.getFloat64(offset, le)),
  };
}
```
`parseFileRecord`, `readWords`, and `parseDaf` each already call
`toDataView()` exactly once at the top -- add one new optional
trailing parameter to each (`checkRange`), passed through to
`toDataView()`, defaulting to `undefined` everywhere it isn't
supplied. Every existing caller (all of `spk.js`/`pck.js`/every
existing test) passes nothing and is provably unaffected -- verify
that claim the same way the DataView port itself was verified: full
existing suite + crossval green with no changes to either. Only
`src/lazy/`'s own calls pass a `checkRange` that checks against
`RemoteSpkFile.populatedBlocks` and throws `RemoteSpkFile: byte range
[x, y) was not prefetched -- widen the query window and retry`.

**Tests:**
- `test/lazy/remoteFile.test.js`: `ensureRange()` against a fake
  `resolveRange` (an in-memory function logging every range asked
  for, serving from a real `writeSpk()`-built buffer) -- block
  coalescing (adjacent misses become one request), cache-hit reuse (a
  populated block is never re-fetched), and a `cache` option
  populated correctly.
- `test/lazy/byteRange.test.js`: exact byte-range assertions for
  type 2/3 given a segment's real epilog + a query window -- this is
  pure arithmetic, so assert it precisely (deterministic expected
  ranges), not just "the eventual answer came out right."
- `test/lazy/prefetch.test.js`, against a synthetic multi-segment
  `writeSpk()` fixture (Earth-rel-EMB, EMB-rel-SSB, mirroring the real
  chain) and a fake remote source: (a) the exact set of ranges
  requested for a given `(target, center, etStart, etEnd)`, (b) the
  resulting `spkez()` call against `remote.pool` is bit-identical to
  the eager `furnsh()`-then-`spkez()` path on the same fixture, (c)
  querying an `et` outside the prefetched window throws the "not
  prefetched" error from `daf.js`'s new hook, not a wrong answer.
- `test/daf.test.js`: a `checkRange` unit test directly (a segment
  reader configured to always throw, confirming the hook actually
  fires for a real `readWords`/`parseFileRecord`/`parseDaf` call) plus
  confirmation every *existing* test in that file still passes calling
  the same functions with no `checkRange` argument at all.
- Not part of `npm test` (matches `crossval/`'s own "needs network,
  kept separate" precedent): a script mirroring this document's proof
  of concept, automated -- real ranges fetched from the real
  `de440s.bsp`, compared against `spiceypy.spkgeo` for a handful of
  epochs across the query window. Lives alongside `crossval/`, run
  manually/in CI-if-configured, not on every `npm test`.

**Depends on:** nothing beyond what already exists (`load()`/`cache.js`
for the fetch/cache primitives it reuses conceptually, though
`RemoteSpkFile` needs its own block-aligned cache shape -- see
`docs/browser-support.md` §3.5's whole-file cache vs. this phase's
block-aligned one).

**Rough size:** the largest phase by far -- comparable to or slightly
larger than the `load()`/`cache.js` round (Phase 2-3 of
`docs/browser-support.md`), since it's building genuinely new
infrastructure (`RemoteSpkFile`, the `checkRange` hook, the prefetch
orchestration) rather than composing existing pieces.

### Phase 2 -- types 8/12 (Lagrange/Hermite, equal step) ✅ implemented

**Modified: `src/lazy/byteRange.js`** -- add the `case 8: case 12:`
branch to `byteRangeForQuery()`'s dispatch. Same complexity class as
2/3: the epilog is `begin`/`step`/`degree`/`N` instead of
`init`/`intlen`/`rsize`/`n`, and the touched *window* of states for
`[etStart, etEnd]` is still arithmetic -- but it isn't *quite* the
same formula as a single-point window lookup, since a time *range*
needs the union of every window touched across it, not just one
centered window. Cleanest done by factoring the "which index range
does `[etStart, etEnd]` touch" computation out of
`interpolatedRecord.js`'s existing `windowStart()`/
`selectEqualStepWindow()` into a small new pure exported helper (e.g.
`windowRangeForQuery(begin, step, degree, n, etStart, etEnd)`), reused
by both the real single-point reader (unaffected -- still calls it
with `etStart === etEnd`, or keeps its own single-point logic
untouched and only the new range-aware helper is added alongside it)
and `byteRange.js`. Reusing rather than duplicating the windowing
formula matters here specifically because a drift between "what
`byteRange.js` predicts will be read" and "what `interpolatedRecord.js`
actually reads" is exactly the failure mode the `checkRange` hook from
Phase 1 exists to catch -- so getting this reuse right is what makes
that hook mostly never fire in practice, not just a safety net for
bugs elsewhere.

**Tests:** the same three test files from Phase 1 (`byteRange.test.js`,
`prefetch.test.js`, plus a synthetic type-8/12 fixture) gain a
parallel set of cases for these types, following the exact pattern
already used for types 2/3.

**Depends on:** Phase 1 (uses `RemoteSpkFile`/`prefetchSpkQuery`/the
`checkRange` hook unchanged).

**Rough size:** small -- roughly a quarter of Phase 1, almost entirely
in `byteRange.js` plus the `interpolatedRecord.js` refactor to expose
the shared windowing formula.

### Phase 3 -- types 9/13/5 (unequal step), small-`N` case ✅ implemented

**Modified: `src/lazy/byteRange.js`** -- add the `case 5: case 9: case 13:`
branch. Unlike 2/3/8/12, window/bracket selection here is
*data-dependent* (epochs aren't evenly spaced), so this branch is
itself a small two-step async operation, not pure arithmetic:
1. `ensureRange()` the segment's own trailer (`trailerField`, `N` --
   the last 2 words) to learn `N`.
2. Compute the epoch array's address span from `N` (same address math
   `readUnequalStepEpochs()` in `interpolatedRecord.js` already uses)
   and `ensureRange()` it -- for a modest `N` (kernels with `N` in the
   thousands; `N=6850` in the EMB-rel-SSB segment measured above is
   only ~55 KB), this is still cheap relative to the whole file.
3. Call `interpolatedRecord.js`'s existing `readUnequalStepEpochs()`/
   `lastEpochAtOrBefore()`/`selectBracketingPair()` directly, unmodified
   -- they already operate on whatever's in `segment.buffer` at the
   segment's real addresses, so once the epoch array is populated they
   just work, the same "existing reader needs no changes" property
   from Phase 1.
4. From the touched epoch indices, compute the states' byte range
   (arithmetic, same shape as 2/3/8/12) and `ensureRange()` it.

**Tests:** a synthetic type-9/13/5 fixture (`N` in the low hundreds,
well under Phase 4's directory threshold), exercising the two-phase
fetch (trailer+`N`, then epoch array, then states) with exact-range
assertions for each step, plus the same eager-path cross-check and
under-prefetch error-path tests as Phases 1-2.

**Depends on:** Phase 1. Independent of Phase 2.

**Rough size:** small-medium -- the two-step fetch is more moving
parts than 2/3/8/12's one-shot arithmetic, but reuses
`interpolatedRecord.js`'s existing epoch-reading functions entirely
unmodified.

**Type 21 (extended difference lines) added later, same phase.** Its
epoch/directory layout is byte-for-byte the same family as 5/9/13 (see
`interpolatedRecord.js`'s own doc comment) -- `readUnequalStepEpochs()`
is reused completely unchanged, `trailerField` just means `maxdim`
instead of a degree or GM. The real differences are record *selection*
(exactly one record, the *first* whose own **coverage-end** epoch --
not its reference epoch -- is `>= et`; no window or bracketing pair,
and this is a genuinely different rule from 5/9/13's own bracketing,
not just a relabeling -- see `interpolatedRecord.js`'s module doc
comment for the real-CSPICE confirmation and the bug this caught) and
record *size* (`4*maxdim+11` words, not a fixed 6-word state) --
`differenceLineIndexRangeForQuery()` and `type21ByteRange()` are the
type 21 counterparts of `unequalStepIndexRangeForQuery()`/
`unequalStepByteRange()`, following this same two-step fetch shape
unchanged.

### Phase 4 -- types 9/13/5/21, large-`N` case (on-disk directory) -- not implemented, as planned

This is the one phase that needs new *format-decoding* work, not just
new *lazy-loading* work, and needs its own source-verification pass
before it can be scoped as precisely as Phases 1-3 were -- unlike
those, spiceJS has never read this part of the format before. Flagged
here as a placeholder for that verification, not a finished plan:

- **What's known already** (from `interpolatedRecord.js`'s own doc
  comment): real SPK/PCK files of types 5/9/13 carry an on-disk
  "directory" -- one entry per 100 epochs -- specifically so a reader
  can binary-search *that* first and narrow to a ~100-epoch
  neighborhood, instead of reading the full epoch array for very large
  `N`. spiceJS's reader (`readUnequalStepEpochs()`) currently always
  reads the full array and explicitly skips the directory; the
  test-only writer (`test/helpers/writeSpk.js`) caps synthetic
  segments at `N <= 100` specifically so it never has to write one.
- **What needs verifying against source before writing any code**
  (matching this project's established practice for every new format
  piece so far): the directory's exact on-disk layout and addressing,
  from NAIF's `spkr09.c`/`spkr05.c` (or the equivalent PCK reader) in
  the OpenSpace/Spice mirror -- this document doesn't have that
  detail yet.
- **Shape of the work, once verified:** a new `readDirectory(segment)`
  in `interpolatedRecord.js`, a directory-aware
  `findEpochNear(segment, et)` replacing the always-read-everything
  path for large `N`, and `test/helpers/writeSpk.js` extended to
  actually *write* a directory (removing today's `N <= 100` cap) so
  the new reading code has a real fixture to test against. This phase
  should get its own short planning pass when it's actually picked up
  -- the same way SPK type 5/`PROP2B` did -- rather than being fully
  speced inside this document without that source-verification step
  having happened yet.

**Depends on:** Phase 3 (extends the same `byteRange.js` branch).

**Rough size:** unknown until the source-verification pass happens;
likely comparable to Phase 1 given it's also genuinely new
infrastructure, not composition of existing pieces.

### Phase 5 -- PCK wiring ✅ implemented

**Modified: `src/lazy/prefetch.js`** -- generalize
`prefetchSpkQuery()`'s segment-finding step (`findChainSegments`, built
around SPK's target/center chain) so the same `RemoteSpkFile`/
`byteRangeForQuery()`/`checkRange` machinery also serves PCK's
frame-based lookup (`pck.js`'s `pckSegments()`/frame matching, not a
target/center chain at all). Concretely: factor `prefetchSpkQuery()`
into a generic `prefetchQuery(remoteFile, pool, { findSegments,
etStart, etEnd, lightTimeMargin })` where `findSegments(daf.summaries)`
is the one SPK-specific (or PCK-specific) piece, and add a thin
`prefetchPckQuery()`/`openRemotePck()` wrapper supplying PCK's own
`findSegments`. `byteRangeForQuery()` itself needs no PCK-specific
case -- PCK's binary segment types are byte-for-byte the same
addressing as SPK's for types 2/3 (and, if built, 5/8/9/12/13), so the
exact same dispatch already covers it.

**Tests:** a synthetic `writePck()` fixture, mirroring
`prefetch.test.js`'s pattern -- exact ranges, eager-path cross-check,
under-prefetch error path -- for a PCK type 2/3 segment reached via
`rotateState()`'s `ref` lookup instead of `spkez()`'s target/center
chain.

**Depends on:** Phase 1 (and whichever of 2-4 the PCK data in question
actually uses -- most real body-orientation kernels are type 2, so
Phase 1 alone is enough to cover the common case here too).

**Rough size:** small -- mostly plumbing/generalization once Phase 1's
machinery exists, no new format understanding needed.

## Fix: structural discovery walked the summary-record chain the wrong way

Adding the satellite kernels (see `kernels/sources.mjs`) surfaced a bug
that had been invisible for every file tested until then.

`prefetchQuery()` used to fetch the DAF summary records with a single
bulk `ensureRange(FWARD, BWARD)` -- the first and last summary record
numbers, both named right in the file record. That fetches the whole
*span* between them, not the records themselves. For the usual layout,
where summary records cluster at the front of the file, the span is a
couple of KB and the two are indistinguishable. For a file whose
summary records are scattered through it -- which happens naturally
when a DAF grows by appending -- the span is most of the file.

Measured on the real `ura184_part-3.bsp` (386.9 MB): the bulk range
pulled **334 MB, 86% of the entire file**, to answer one query. Lazy
loading had effectively stopped working on exactly the kind of file it
exists for.

The fix walks the chain the way `parseDaf()` already does: fetch record
FWARD, read its NEXT pointer (the record's first word), fetch that one,
repeat. Each is 1024 bytes, so each costs one block. Same file, after:
**0.50 MiB, 0.136%** -- and the answer (Ariel relative to the SSB) is
unchanged. Every other kernel tested was unaffected either way.

`test/lazy/prefetch.test.js` has a regression test that builds a
deliberately scattered chain and asserts the gap between records is
never fetched; it fails loudly against the old bulk-range code.

## Serving kernels through a range-caching proxy

`openRemoteSpk()` needs a URL that (a) honours HTTP Range requests and
(b) is readable by the page. NAIF satisfies the first and, for a
browser, fails the second: no `Access-Control-Allow-Origin` on any
response, so a cross-origin `fetch()` can never read the bytes --
caching doesn't help, because caching an unreadable response leaves it
unreadable.

`scripts/serve-example.mjs` (`npm run serve-example`) closes that gap
with a proxy that is, deliberately, the same design as
`src/lazy/remoteFile.js` -- just on disk instead of in memory:

```
browser                    proxy (same origin)              NAIF
  |  GET /kernels/remote/de440.bsp        |                   |
  |  Range: bytes=1048576-1114111         |                   |
  |-------------------------------------->|                   |
  |                    block present?  ---+                   |
  |                       no -> Range GET |------------------>|
  |                          write into sparse file, set bit  |
  |  206 Partial Content <----------------|                   |
```

Per kernel it keeps two files under `kernels/cache/`:

- `de440.bsp` -- a **sparse** file the full length of the remote one.
  Unwritten regions are holes: they read as zeros and cost no disk.
- `de440.bsp.blocks` -- a bitmap, one bit per block, recording which
  blocks hold real bytes. The bitmap, never the file length, is the
  source of truth; a filesystem without sparse support just stores the
  zeros, and correctness is unaffected.

A read rounds out to block boundaries, fetches only blocks whose bits
are clear (coalescing adjacent misses into one upstream request,
sharing in-flight promises so concurrent requests never double-fetch),
commits them, then answers from local disk. Restarting the server keeps
everything, because both pieces are just files.

**Block size is the one real tuning knob**, and measurement overturned
the initial guess. The first cut used 1 MiB blocks, reasoning that
fewer round trips to a slow server would win. Measured against the real
`de440s.bsp`, for exactly the query the demo makes on load (23 browser
reads, 1.47 MB):

| block size | upstream requests | upstream bytes | amplification |
| --- | --- | --- | --- |
| 64 KiB | 23 | 1.47 MB | 1.0x |
| 128 KiB | 23 | 2.97 MB | 2.0x |
| 256 KiB | 21 | 5.46 MB | 3.7x |
| 512 KiB | 18 | 9.13 MB | 6.2x |
| 1 MiB | 15 | 14.90 MB | 10.2x |

1 MiB cost 10x the bytes to save 8 of 23 requests -- these reads are
scattered (one per segment epilog/record range, not a sequential scan),
so larger blocks mostly pull neighbours nothing asked for. The default
is now 64 KiB, matching `remoteFile.js`'s own block size exactly, which
makes the proxy fetch precisely what the page asked for and nothing
else.

Real numbers from a verified session: five kernels totalling 4.95 GB
apparent, **22 MB actually on disk**; a cold demo load of `de440s`
took 5.6 s and a warm one 1.8 s with zero upstream fetches. And
`ura184_part-1.bsp` -- 2.06 GB -- costs 1.0 MB of disk to open.

## What actually shipped (differences from the plan above, and why)

The plan above was written before implementation; a few things came
out differently once actually building and testing them. Recorded
here rather than silently rewriting the plan, since the reasoning is
worth keeping:

- **The `checkRange` mechanism is discovered as a property on the
  buffer object, not threaded as an explicit parameter.** The
  original sketch (`readWords(bytes, ..., checkRange)`, with
  `parseFileRecord`/`parseDaf` growing a matching parameter) would
  only have protected `prefetch.js`'s *own* direct `daf.js` calls
  (structural discovery, epilog reads) -- it would **not** have
  protected a read made deep inside `chebyshevRecord.js`'s
  `selectRecord()` or `interpolatedRecord.js`'s window/bracket readers
  during an *ordinary, unmodified `spkez()` call after `prefetch()`
  resolves* -- which is the case that actually matters, since none of
  those existing call sites would ever pass the new parameter. Fixed
  by having `daf.js`'s `toDataView()`/`decodeLatin1()` look for an
  optional `bytes.checkRange` method instead: `RemoteFile`'s buffer
  carries one (set up once, in `openRemoteFile()`/its constructor),
  so *every* read against it is validated automatically, with zero
  signature changes anywhere in `daf.js`, and zero behavior change for
  every plain `Buffer`/`Uint8Array` (which simply doesn't have the
  property) -- confirmed by the full existing suite + crossval passing
  unchanged. See `src/daf.js`'s doc comment and `src/lazy/remoteFile.js`.
- **`byteRangeForQuery()` fetches its own epilog/trailer internally**
  (`async`, taking `remoteFile` directly), rather than `prefetch.js`
  doing a generic "always the last 4 words" epilog fetch before calling
  a synchronous `byteRangeForQuery(segment, epilog, ...)`. This has to
  work this way once Phase 3 exists: types 5/9/13's trailer is only 2
  words (not 4), and needs a *second*, data-dependent fetch (the epoch
  array, whose address depends on `N`, which is only known after the
  first fetch) before the touched state range is even computable --
  a single generic "fetch 4 words, then compute" step in `prefetch.js`
  couldn't express that. Each type's handler in `byteRange.js` now
  owns its own fetch steps entirely; `prefetch.js` just calls
  `byteRangeForQuery()` once and `ensureRange()`s whatever range comes
  back.
- **Block-alignment means "populated" is coarser than "exactly
  requested."** `ensureRange()` rounds every request out to whole
  blocks (per `docs/browser-support.md` §3.6's design), so a byte
  adjacent to a legitimately-fetched one can end up populated too, as
  a side effect -- the `checkRange` guarantee is "every byte any
  `ensureRange()` call's *rounded* span covered is safe to read," not
  "only the exact minimal bytes a query needed are readable." This
  surfaced directly while writing Phase 3's tests: a `blockBytes: 128`
  test on a tiny synthetic file coincidentally swept an *unprefetched*
  bracket's bytes into the same populated blocks as the prefetched
  one, so querying it didn't throw as the test first assumed --
  correct behavior once understood (fewer HTTP requests is the whole
  point of block alignment), just a sharper edge on the safety-net's
  actual guarantee than the earlier "throws for anything not
  requested" phrasing implied.
- **`spkez(target, observer, ...)`'s target/observer chaining, not
  "target down to a single center"**, was already corrected during
  this document's own drafting (before code existed) after re-checking
  against `spk.js`'s real `chainStateToSsb()` -- noted here only so the
  "Two architectures" section's earlier, more mechanical framing isn't
  read as the final word.
- **Verification**: the `de440s.bsp` worked example at the top of this
  document was re-run through the actual shipped code (`openRemoteSpk`
  + `prefetchSpkQuery`, real `fetch()` against the live file, not a
  hand-built sparse buffer) and matched `spiceypy` to full double
  precision -- 5 HTTP requests, 285,696 bytes (0.87% of the file) for
  the same 1-year Earth-vs-EMB-vs-SSB query. (One environment-specific
  footnote, not a finding about the library itself: this sandbox's
  outbound-network proxy required `NODE_USE_ENV_PROXY=1` for Node's
  built-in `fetch()` to route through it at all -- unrelated to
  `openRemoteSpk()`'s own `resolveRange`/`getFileLength` logic, which
  just calls `fetch()` normally and works in a real browser or a
  normally-configured Node environment without it.)

Phase 4 was not attempted -- it remains exactly what the plan above
says: needs its own source-verification pass against NAIF's
`spkr09.c`/`spkr05.c` before it can be scoped, let alone built.
