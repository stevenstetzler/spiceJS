# Scoping lazy/range-based kernel loading

This is a scoping document for `docs/browser-support.md` §3.6 (block-
aligned lazy/range loading) -- not implemented yet. It works through
the concrete example the design was motivated by: lazily loading
`de440.bsp` and calling `spkez` for Earth over a time range `[t1, t2]`,
fetching only the bytes that query actually needs.

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

- It touches *zero* lines of `daf.js`/`spk.js`/`pck.js`/
  `chebyshevRecord.js`/`interpolatedRecord.js` -- no risk to the
  180-plus tests and 619 crossval cases already validating that code,
  and no need to re-earn that confidence for an async rewrite of the
  same logic.
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
well (see "Fallback behavior" below for how Design A degrades in that
case in the meantime -- a clear error, not silent wrong data).

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

## Design

### A remote byte source, with a population-tracking sparse buffer

```
RemoteSpkFile
  url, cache (from cache.js, extended to block-aligned storage --
    see docs/browser-support.md §3.6)
  fileLength                       // from the first response's Content-Range/Content-Length
  buffer: Uint8Array(fileLength)   // one real allocation, mostly zero-filled
  populated: a set/bitmap of which fixed-size (e.g. 64 KiB) blocks
    of `buffer` actually hold real fetched data

  async ensureRange(startByte, endByte):
    missing = blocks touching [startByte, endByte) not in `populated`
    if missing: fetch them (coalescing adjacent misses into as few
      Range GETs as possible), populate `buffer` + `cache`, mark
      `populated`
```

The `fileLength`-sized allocation costs real memory (114 MB for the
full `de440.bsp`) even though almost none of it is ever written --
worth confirming this is an acceptable tradeoff for the memory budget
of whatever's using this (typically fine: it's a one-time, mostly-zero
allocation, dramatically cheaper than the *network* transfer this is
solving for, and V8/browsers handle large sparse/mostly-zero typed
arrays without materializing physical pages for the untouched parts on
most platforms). If it isn't acceptable for some target environment, a
`Map<blockIndex, Uint8Array>`-backed sparse structure is the
alternative -- more bookkeeping, no need to reserve the full address
space up front.

**Reads outside a populated range must throw, not silently read
zeros.** This is the one place Design A's "reuse the existing reader
unchanged" plan needs a small, deliberate seam: `daf.js`'s `readWords`/
`parseFileRecord`/`toDataView` operate directly on whatever
`Uint8Array` they're given, with no way to know "this range wasn't
actually fetched" on their own -- a naive zero-padded buffer (as in
the proof of concept above, which controlled its own query precisely)
would silently hand back a plausible-looking wrong answer for any read
outside what was prefetched, exactly the class of bug this whole
project has avoided everywhere else. So the buffer handed to `daf.js`
needs a thin `.get()`-time (or construction-time-guarded) check against
`populated`, throwing a clear, catchable error (e.g. `RemoteSpkFile:
byte range [x, y) was not prefetched -- widen the query window and
retry`) instead of ever returning unpopulated bytes. This is a few
lines, not a redesign, and it's the only place "reuse `daf.js`
unchanged" needs a companion safety net rather than a code change.

### The prefetch step

```js
async function prefetchSpkQuery(remoteFile, { target, center, etStart, etEnd, lightTimeMargin = 0 }) {
  // 1. Structural metadata (cheap, and the same for every query
  //    against this file -- cache it once per file, not per query).
  await remoteFile.ensureRange(0, FILE_RECORD_BYTES);              // file record
  const fileRecord = parseFileRecord(remoteFile.buffer);
  await remoteFile.ensureRange(                                    // summary record chain
    (fileRecord.fward - 1) * FILE_RECORD_BYTES,
    fileRecord.bward * FILE_RECORD_BYTES
  );
  const daf = parseDaf(remoteFile.buffer);                         // unmodified daf.js call

  // 2. Find the segment(s) chaining target -> ... -> center (reusing
  //    the existing chain-walking shape from spk.js's chainStateToSsb,
  //    generalized to "target down to center" instead of "down to
  //    the SSB" specifically).
  const chain = findChainSegments(daf.summaries, target, center);

  // 3. Per segment: epilog, then the type-specific byte range for
  //    [etStart - lightTimeMargin, etEnd + lightTimeMargin].
  for (const seg of chain) {
    await remoteFile.ensureRange(...epilogRange(seg));
    const range = byteRangeForQuery(seg, etStart - lightTimeMargin, etEnd + lightTimeMargin); // per §"per segment type" above
    await remoteFile.ensureRange(range.start, range.end);
  }
}
```

`lightTimeMargin` matters for `abcorr != 'NONE'`: light-time
correction queries the target segment at `et ± lightTime`, which can
land slightly outside `[etStart, etEnd]` (up to ~20-25 minutes for
outer-planet distances). A caller doing a single-epoch `spkez` call
with light-time correction should pass a margin (a fixed conservative
bound, e.g. 30 minutes, is simpler and safer than trying to compute
the true light time before knowing the position -- exactly the
chicken-and-egg `spkez` itself already resolves by iterating). Central-
differencing for velocity (`VELOCITY_DERIVATIVE_STEP_S = 1` second, in
`spk.js`) is negligible and never needs its own margin.

### The public shape

```js
import { openRemoteSpk } from 'spicejs/browser'; // sketch -- not the final name

const remote = await openRemoteSpk('https://your-cors-enabled-host/de440.bsp', { cache });
await remote.prefetch({ target: 399, center: 0, etStart: t1, etEnd: t2, abcorr: 'LT+S' });

// Ordinary, synchronous, completely unmodified spkez() from here --
// remote.pool is a normal KernelPool that decodeKernel() populated
// against remote.buffer the same way furnsh()/load() do today.
const { position, velocity } = spkez(399, 0, someEtBetweenT1AndT2, 'LT+S', null, remote.pool);
```

If a later `spkez` call touches an epoch (or a chain hop) the
`prefetch()` call didn't anticipate, it throws the "not prefetched"
error above -- catch it, call `prefetch()` again for the wider/
different range, and retry. This is a *coarser* API than `load()`'s
"just works, fetch whatever's needed" model, and that's an intentional
tradeoff for staying on the synchronous reader -- worth confirming this
shape (explicit prefetch, catchable under-fetch errors) is an
acceptable API surface before building it, versus, say, an
auto-retrying wrapper that catches the error and re-prefetches with a
widened margin internally (doable as a thin convenience layer on top
of the above, without changing the core design).

## Testing strategy

- **Exact-byte-range assertions against a fake remote source** (an
  in-memory object serving from a real synthetic `writeSpk()` fixture,
  logging every range requested): since type 2/3/8/12 addressing is
  pure arithmetic, the exact set of bytes a given query should touch
  is independently computable and 100% deterministic -- assert it
  precisely, not just "did the answer come out right." This is the
  same rigor `daf.test.js`'s new byteOffset-view test used, applied to
  "did we request the right ranges" instead of "did we decode them
  right."
- **Cross-check against the eager (whole-file) path**: for the same
  synthetic or real fixture and the same query, the lazy path's result
  must be bit-identical to today's `furnsh()`-then-`spkez()` path --
  proves the sparse-buffer/population-tracking machinery is
  transparent to the reader, the same property the de440s proof of
  concept above demonstrated by hand against real CSPICE.
- **The "not prefetched" error path**: deliberately prefetch too
  narrow a window (or omit a chain hop) and confirm a clear, specific,
  catchable error -- not a wrong answer, not a generic crash.
- **A real-kernel integration test** (mirroring this document's proof
  of concept, automated): fetch real ranges from a small real kernel
  already used elsewhere in this repo (`crossval/dss17.bsp`) and
  confirm the result matches what `furnsh()`-ing the whole file
  produces.

## Suggested phasing

1. **Types 2/3 only** -- covers `de440`/`de440s` and the large
   majority of real distributed kernels exactly as scoped above. The
   `RemoteSpkFile`/population-tracking/prefetch-orchestration
   machinery built here is what every later phase reuses; only the
   per-segment-type `byteRangeForQuery()` function changes.
2. **Types 8/12** -- small addition once 1 lands (same arithmetic
   addressing, different epilog fields).
3. **Types 9/13/5, small-`N` case** -- fetch the whole epoch array,
   binary-search locally. Still no new on-disk-format work.
4. **Types 9/13/5, large-`N` case** -- implement on-disk directory
   reading in `interpolatedRecord.js` for the first time. Scoped
   separately because it's new format-decoding work, not a reuse of
   anything that exists today, and the kernels that actually need it
   (huge `N`) are a smaller slice of real-world usage than 1-3.
5. **PCK wiring** -- thread `pck.js`'s segments through the same
   `RemoteSpkFile`/prefetch machinery built in 1-2 (body-fixed `ref`
   lookups), since PCK type 2/3 is byte-for-byte the same addressing
   as SPK's.

Each phase is independently useful and testable, same as the browser-
support phases before it -- 1 alone already delivers the motivating
`de440` scenario in full.
