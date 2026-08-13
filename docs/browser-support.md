# Running spiceJS in the browser

This is an investigation, not an implementation -- nothing here is
committed to `src/` yet. It answers three questions: what currently
stops spiceJS from running in a browser at all, what stops it from
loading kernels over the network, and what a local-cache layer should
look like. It ends with a phased plan and a short list of decisions
that need a call before writing code.

## 1. What's actually Node-specific today

Searching `src/` for Node-only APIs turns up exactly two files:

- **`src/kernels.js`**: `import fs from 'node:fs'` and `import path
  from 'node:path'`. `furnsh()` does `fs.readFileSync(absPath)` and
  resolves meta-kernel (`KPL/MK`) relative paths with `path.resolve`/
  `path.dirname`. This is the *only* place spiceJS touches the
  filesystem.
- **`src/daf.js`**: the DAF binary reader uses Node `Buffer`-only
  methods -- `buffer.toString('latin1', start, end)`,
  `buffer.readInt32LE`/`readInt32BE`, `buffer.readDoubleLE`/
  `readDoubleBE`. Every other binary-format file (`spk.js`, `pck.js`,
  `math/chebyshevRecord.js`, `math/interpolatedRecord.js`) only ever
  calls `readWords()`/`parseFileRecord()` from `daf.js` -- none of
  them touch `Buffer` directly. So the *entire* binary-parsing layer's
  Node dependency is centralized in one file.

Nothing else in `src/` (frames, bodies, time, text-kernel parsing,
`prop2b`, etc.) touches `fs`, `path`, `Buffer`, or `process`. That's a
genuinely small surface to fix -- this is good news, not a rewrite.

`test/helpers/writeSpk.js`/`writePck.js` use `Buffer` too, but those
are Node-only test fixtures and don't need to run in a browser.

## 2. What the network side actually looks like (tested against real naif.jpl.nasa.gov)

Two things needed checking before designing anything: does NAIF's
server allow cross-origin `fetch()` at all, and does it support the
techniques (range reads, conditional requests) a lazy/caching loader
would want to use.

**No CORS.** A request with an `Origin` header gets back a normal
response with no `Access-Control-Allow-Origin`:

```
$ curl -sSI -H "Origin: https://example.com" \
    https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls
HTTP/1.1 200 OK
Server: Apache
Last-Modified: Fri, 15 Jul 2016 00:00:37 GMT
Accept-Ranges: bytes
Content-Length: 5257
Content-Type: text/plain; charset=UTF-8
```

No `Access-Control-Allow-Origin` anywhere. **A browser page on any
other origin cannot `fetch()` naif.jpl.nasa.gov directly** -- the
request goes out, but the browser blocks the script from reading the
response. This is the single biggest constraint on the whole design:
spiceJS cannot ship a `furnsh('https://naif.jpl.nasa.gov/...')` that
just works from an arbitrary web page. Something has to sit in front
of NAIF (see \S5).

**Range requests work.** `Accept-Ranges: bytes` above isn't a fluke:

```
$ curl -sSI https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp
HTTP/1.1 200 OK
Accept-Ranges: bytes
Content-Length: 32726016
Content-Type: model/vnd.valve.source.compiled-map

$ curl -sS -r 0-1023 -D - -o /dev/null \
    https://naif.jpl.nasa.gov/.../de440s.bsp
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/32726016
```

A real 206 partial response for an arbitrary byte range. That matters
because DAF is *already* a random-access, word-addressed format (see
`daf.js`'s doc comment) -- `parseFileRecord` only needs the first 1024
bytes, walking the summary-record chain only needs a handful of 1024-
byte records, and evaluating one `spkezr()` call only needs the one
segment's data, not the whole file. `de440s.bsp` is 32 MB; the general
relativity-grade `de440.bsp` is over 100 MB. Range GETs are what make
it possible to answer a single query without ever downloading the
whole file.

**Conditional GET works**, even with no `ETag`/`Cache-Control` in the
response (Apache still honors `Last-Modified`):

```
$ curl -sS -H "If-Modified-Since: Mon, 21 Dec 2020 19:39:26 GMT" \
    -D - -o /dev/null https://naif.jpl.nasa.gov/.../de440s.bsp
HTTP/1.1 304 Not Modified
```

So a proxy (or any same-origin server) sitting in front of NAIF can
cheaply revalidate a cached copy instead of blindly re-fetching it --
important since NAIF's own kernels are essentially immutable once
published (new data ships under a new filename, e.g. `de440` vs.
`de441`), so a long-lived cache is safe, not just an optimization.

## 3. Proposed architecture

Four separate concerns, each independently useful, each currently
tangled together inside `kernels.js`'s `furnsh()`:

```
 kernel reference           byte source              cache            binary decode
 (path / URL / File /   →   resolver          →      (optional)   →   (already
  Blob / bytes)              (env-specific)                              portable
                                                                          once daf.js
                                                                          is fixed)
```

### 3.1 Make `daf.js` platform-agnostic -- carefully, not just "swap the calls"

Replace every `Buffer`-only call with a `DataView` equivalent, which
both Node (≥ 11) and every browser implement identically. This is
*not* the mechanical zero-risk swap it looks like at first glance --
two specific hazards need to be designed around, not just tested for
after the fact:

| Buffer call | DataView equivalent | Hazard |
|---|---|---|
| `buf.readInt32LE(o)` / `readInt32BE(o)` | `new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(o, littleEndian)` | `DataView.getX(o, ...)` addresses `o` relative to the *view's own* start, which itself may already be offset into a larger `ArrayBuffer` (`buf.byteOffset`). Get the `DataView` constructor's three arguments wrong (e.g. forget `byteOffset`/`byteLength` when the source isn't a plain, unsliced `Uint8Array`) and reads silently shift by a constant -- wrong data, no error. **Current code is actually safe from this today**: every raw-byte read in `daf.js` (`readAscii`, `parseFileRecord`'s `readInt32`, `readWords`, `parseDaf`'s inline record reads) indexes into the one whole-file buffer passed into `parseDaf`/`parseFileRecord` with an absolute offset -- nothing currently calls these on a `.subarray()`/sliced view. That invariant ("always the whole file, always an absolute byte offset") has to be *preserved* by the port, not just hoped for -- worth a one-line comment at the top of `daf.js` saying so explicitly, so a future change doesn't quietly introduce a sliced-buffer call site. |
| `buf.readDoubleLE(o)` / `readDoubleBE(o)` | `dv.getFloat64(o, littleEndian)` | Same offset caveat as above. |
| `buf.toString('latin1', s, e)` | **Not** `new TextDecoder('latin1').decode(...)` | These look interchangeable and aren't: the WHATWG `TextDecoder` label `"latin1"` is actually a windows-1252 alias, which remaps bytes 0x80-0x9F to C1 control characters/smart-quote-style symbols instead of passing them through -- unlike Node's `Buffer` `'latin1'`, which is a pure byte-for-byte ISO-8859-1 passthrough (every byte 0-255 maps straight to the same-valued code point). For DAF's `LOCIDW`/`LOCFMT` fields this rarely bites (they're plain ASCII), but the 1000-byte reserved/comment area (bytes 96-1024 of the file record) can contain arbitrary bytes, and a decode/re-encode round trip through the wrong table would corrupt it. The correct portable equivalent is a hand-rolled loop, not a Web API: `let s = ''; for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]); return s;` -- four lines, and exactly matches Node's `'latin1'` semantics in both environments. |
| `buf.length` | `buf.byteLength` (works on `Uint8Array` too) |  |

Endianness is already handled correctly today and just needs to
survive the port unchanged: `daf.js` already reads `LOCFMT` from the
file record and threads a `littleEndian` boolean through every
subsequent read (`readWords(buffer, littleEndian, ...)`,
`parseFileRecord`'s `readInt32`) rather than hardcoding one byte
order -- so old big-endian (`BIG-IEEE`) kernels are already supported,
not just little-endian ones. `DataView.getInt32(offset, littleEndian)`
/`getFloat64(offset, littleEndian)` take that same boolean as an
explicit second argument on every call, which is if anything a better
fit than `Buffer`'s method-name-encoded endianness (`readInt32LE` vs.
`readInt32BE`) -- there's no separate "did I use the right method
name" failure mode to introduce. This is a preserved invariant to
verify, not new work to design.

`readWords()` already returns a `Float64Array`, which is
environment-agnostic and unaffected by any of the above --
`spk.js`/`pck.js`'s `.subarray()` calls (e.g. `record.subarray(start,
start + ncoef)`) operate on that already-decoded `Float64Array`, not
on raw bytes, so they're not part of this hazard at all.

**Testing this port needs more than "the existing suite still
passes."** The existing 175 unit tests + 619 crossval cases exercise
*outcomes* (does `spkezr()` return the right position), which is
necessary but not sufficient to catch a systematic-but-small offset
error (e.g. an off-by-`byteOffset` shift that happens to still parse
without throwing, on data where the shifted read is still
plausible-looking). Add a direct, narrow regression test: read the
same DAF file's words through the pre-port `Buffer` methods and the
post-port `DataView` methods and assert every value is bit-for-bit
identical -- not just "the final computed answer is close enough."
This can be deleted once the port lands and the `Buffer` methods are
gone from the codebase; it exists purely to catch the class of bug
described above during the port itself, not as a lasting regression
guard.

This step overall is still low-risk *given* the above -- it's a
byte-for-byte identical reimplementation with two specific known traps
to avoid, not a redesign -- and unlocks bundling `daf.js`/`spk.js`/
`pck.js` into a browser build today, before touching I/O at all.

Everywhere in `src/` currently typed as "a Node `Buffer`" becomes "a
`Uint8Array`" -- `Buffer` already *is* a `Uint8Array` subclass in
Node, so this is also backward compatible: existing Node callers
passing a `Buffer` keep working unchanged.

### 3.2 Decouple "get the bytes" from "decode the bytes"

`furnsh()` today conflates three things: resolving a path to bytes
(`fs.readFileSync`), sniffing the magic word, and recursively
expanding meta-kernels. Split it:

```js
// New: pure, environment-agnostic, synchronous. Takes bytes it
// already has, not a path. This is what daf.js/spk.js/pck.js/
// textKernel.js already assume -- just exposing it as the public
// entry point instead of burying it inside furnsh().
export function loadKernelBytes(bytes, name, pool) { ... }

// Existing furnsh() becomes a thin Node-specific wrapper:
export function furnsh(filePath, pool = globalPool) {
  const absPath = path.resolve(filePath);
  return loadKernelBytes(fs.readFileSync(absPath), absPath, pool);
}
```

Meta-kernel expansion needs bytes for *each* kernel it lists, which
means recursion still needs a byte-resolver -- `loadKernelBytes` takes
one as a parameter (defaulting to the Node fs-based one) rather than
hardcoding `fs.readFileSync`, so meta-kernel expansion works the same
way in every environment:

```js
function loadKernelBytes(bytes, name, pool, resolve) {
  // ... same magic-word dispatch as today ...
  if (subtype === 'MK') {
    for (const rawPath of kernelsToLoad) {
      const resolved = /* path-symbol substitution, as today */;
      const kernelBytes = await resolve(resolved); // <- the only async point
      await loadKernelBytes(kernelBytes, resolved, pool, resolve);
    }
  }
}
```

### 3.3 Environment-specific byte resolvers

A resolver is just `(reference) => bytes | Promise<bytes>`. Ship a
few, let the caller pick (or write their own -- e.g. an Electron app
resolving through IPC to its main process):

- **Node filesystem** (existing behavior): `fs.readFileSync`, sync.
  This is what `furnsh()` keeps using -- **zero change for existing
  Node callers, zero risk to the 175 passing tests.**
- **Browser `fetch`**: `await fetch(url).then(r => r.arrayBuffer())`.
  Async by nature (see \S3.4). This is the piece that needs a CORS-
  enabled origin in front of it -- see \S5.
- **Local file (browser)**: a `File`/`Blob` the user picked via
  `<input type="file">`, drag-and-drop, or the File System Access API
  (`showOpenFilePicker()`). `await file.arrayBuffer()`. No network, no
  CORS question at all -- this is the *simplest* browser path to
  ship first, and covers the "I already downloaded de440s.bsp,
  now let me use it" case that's probably the most common one anyway.
- **Raw bytes**: caller already has an `ArrayBuffer`/`Uint8Array`
  (fetched some other way, unpacked from a zip, whatever) -- identity
  resolver, sync.

### 3.4 `furnsh()` has to grow an async sibling

`fs.readFileSync` is synchronous, so today's `furnsh()` is
synchronous, and the whole existing test suite calls it that way with
no `await`. `fetch()`, `IndexedDB`, and the async form of File System
Access are all inherently asynchronous -- there's no way to fetch a
kernel over the network and hand back bytes synchronously in a
browser (`XMLHttpRequest` with `async: false` is deprecated,
main-thread-blocking, and doesn't support reading binary responses
usefully in most browsers anymore).

Recommendation: **keep `furnsh()` synchronous and Node-only** (no
change for existing users), and add a new async entry point for
everything else -- named `load()`, not `furnshAsync()`. A `*Async`
suffix implies "this is `furnsh`, plus await," which isn't quite
honest: it takes a wider range of reference types (URL, `File`/`Blob`,
raw bytes) than `furnsh` ever will, and it deliberately doesn't match
`furnsh_c`'s exact semantics (e.g. it's the natural place to hang
caching, which real SPICE's `furnsh_c` has no concept of). `load()`
signals "the new, more general entry point" instead of implying strict
parity with a specific SPICE routine:

```js
export async function load(reference, pool = globalPool, { resolve, cache } = {}) {
  const key = typeof reference === 'string' ? reference : null;
  let bytes = key && cache ? await cache.get(key) : null;
  if (!bytes) {
    bytes = await resolveBytes(reference, resolve); // fetch/File/raw bytes, per §3.3
    if (key && cache) await cache.put(key, bytes);
  }
  return loadKernelBytes(bytes, key ?? '<bytes>', pool, resolve);
}
```

This is a strictly additive change: nothing about `furnsh()`'s
signature, behavior, or the 175 tests exercising it needs to move.

### 3.5 Local caching

For the first cut (whole-file caching, no lazy loading yet), a cache
is just `{ get(key) => bytes|null, put(key, bytes) => void }` (both
async, so every backend fits the same shape). Three real options for
the browser default:

| Backend | Fit for this use case |
|---|---|
| **IndexedDB** | Broadest support (every browser, including Safari). Natural fit for "one binary blob per URL." Async, no size surprises (browsers grant tens of GB under the "persistent storage" quota on user opt-in). **Recommended default.** |
| **Cache API** (`caches.open()`) | Built for exactly this ("cache a fetch response"), and *for free* handles conditional revalidation if paired with real `Response` objects and a same-origin proxy that sets sane cache headers. Good option if the proxy in \S5 is real and the design stays "whole-file cache." |
| **OPFS** (`navigator.storage.getDirectory()`) | Newest (Safari 16.4+, so the least broadly supported of the three), but the best structural match for the *block-based* cache \S3.6 below actually needs: a real random-access file, `createSyncAccessHandle()` gives synchronous `read(buffer, {at: offset})` from a Worker -- i.e. it's the closest browser equivalent to `fs.readSync`. Overkill for a whole-file-only first cut; becomes the natural choice once \S3.6 is built. |

Cache key: the resolved URL (or a caller-supplied name for
non-URL sources like `File`/raw-bytes, which don't need caching --
the browser already "cached" a picked file by not needing to
re-download it). Invalidation: NAIF kernels are immutable once
published, so a straightforward "cache forever, no revalidation"
policy is defensible for the default; a stricter cache can layer
`If-Modified-Since` revalidation (confirmed working in \S2) on top
without changing the interface.

### 3.6 Stretch goal: lazy/range-based loading, with a block-aligned cache

Not needed for a first working version, but worth designing correctly
up front since it changes the cache's shape from \S3.5. The naive
version of this idea -- "cache arbitrary fetched byte ranges as
individual records" -- doesn't actually work well: real reads don't
land on tidy boundaries (a segment's data can start mid-range from an
earlier fetch), so a range-keyed cache needs general interval merging
(detecting overlapping/adjacent ranges and coalescing them) just to
answer "do I already have bytes [x, y)?" -- solvable, but it's
reinventing a small interval-tree library for no real benefit.

The standard fix, and the one to actually build: **normalize every
fetch to fixed-size, byte-offset-aligned blocks** (e.g. 64 KiB,
independent of whatever range a given read actually asked for), and
cache *blocks*, not ranges:

```
getBytes(offset, length):
  neededBlocks = blocks touching [offset, offset+length)
  missing = neededBlocks not already in cache
  if missing: fetch them (one Range GET per contiguous run of missing
    blocks, coalescing adjacent misses into a single request -- DAF
    summary records and nearby-epoch coefficient records cluster, so
    this amortizes well in practice) and cache.put() each
  assemble the requested [offset, offset+length) slice from blocks
```

This turns "which bytes do I have" into a plain integer set/map
lookup (`hasBlock(blockIndex)`), no interval math, and bounds request
count for reasonable read patterns instead of doing one Range GET per
individual `readWords()` call. Conditional-GET revalidation (\S2) then
applies **once per file**, not per block: validate `Last-Modified` at
`load()`-time, and if the file changed, invalidate every cached block
for that key rather than trying to figure out which specific blocks
are now stale.

`parseFileRecord` only ever needs the first 1024 bytes (one block);
walking summaries only touches a handful of 1024-byte records (still
likely one block at 64 KiB); evaluating a single `spkezr()` call only
touches the one matching segment's data. This turns "load a 100+ MB
`de440.bsp` in a browser tab" into "fetch a few blocks per query,"
which matters a lot for a web app that only ever asks about one or two
bodies. This needs `daf.js`'s internal reads to go through an
async/awaitable accessor instead of a plain `Uint8Array` -- a bigger
change than \S3.1-3.5, so it's scoped as a later phase, not part of
"get spiceJS running in a browser at all."

## 4. Are `str2et`/`spkez`/etc. themselves browser-safe?

Yes, already. `str2et.js`, `frames.js`, `bodies.js`, `bodyConstants.js`,
`prop2b.js`, and all of `math/*` are pure computation over plain
arrays/numbers/strings -- no Node API surface at all. Once \S3.1's
`daf.js` fix lands, the entire query side of the library (everything
except `furnsh`/`unload`/`kclear`) is already portable without
further changes.

## 5. The CORS problem needs an answer from whoever's hosting the app

Because naif.jpl.nasa.gov sends no CORS headers (\S2), spiceJS itself
can't make `furnsh('https://naif.jpl.nasa.gov/...')` "just work" from
a browser tab on some other origin -- no client-side trick fixes a
missing `Access-Control-Allow-Origin` header on someone else's server.
The realistic options, in order of how much infrastructure they need:

1. **User supplies the file locally** (\S3.3's `File`/`Blob` resolver)
   -- zero infrastructure, works today, no CORS question at all. Good
   default guidance for anyone embedding spiceJS in a page.
2. **App author re-hosts kernels somewhere CORS-enabled** -- a public
   CDN/object store they control (S3/R2/GCS bucket, GitHub Pages,
   jsDelivr mirror of a repo that vendors the kernel) with
   `Access-Control-Allow-Origin: *` set. This is the standard fix for
   "the API I need doesn't send CORS headers," used constantly for
   exactly this kind of static-file case.
3. **Same-origin (or CORS-enabled) proxy** -- a small server (even a
   single Cloudflare Worker/Vercel edge function) that fetches from
   NAIF server-side and forwards bytes with CORS headers added. Also
   the natural place to add the `If-Modified-Since` revalidation from
   \S2 and to enforce a shared cache across users, rather than every
   browser tab re-fetching a 100 MB file individually.

None of this is spiceJS's problem to solve *in the library* beyond
making the resolver pluggable (\S3.3). **Decision: document a short
(~20-line) reference proxy example -- e.g. a Cloudflare Worker or
Vercel edge function that fetches from NAIF and adds
`Access-Control-Allow-Origin` -- rather than shipping/hosting one.**
This is the single thing most likely to actually block a user, and
the fix is short enough that showing it costs nothing; but *operating*
a public proxy is an ongoing bandwidth bill and a support burden this
project shouldn't take on. Same posture as documenting a sample nginx
config, not standing up a service. Worth stating explicitly in the
eventual README section for this feature so users don't file a bug
wondering why `load('https://naif.jpl.nasa.gov/...')` fails with an
opaque `TypeError: Failed to fetch`.

## 6. Phased plan

1. **`daf.js` → `DataView`, with a hand-rolled latin1 decode (not
   `TextDecoder`)** (\S3.1). Byte-for-byte identical reimplementation
   of the two hazards called out above, verified against the existing
   175 unit tests + 619 crossval cases *plus* a new narrow
   Buffer-vs-DataView equality regression test (deleted once the port
   lands and `Buffer` is gone). Unblocks bundling the decode layer
   into a browser build.
2. **Split `loadKernelBytes()` out of `furnsh()`**, add `load()` with
   pluggable byte resolvers (\S3.2-3.4): `fetch`, `File`/`Blob`, raw
   bytes. No caching yet -- every call re-fetches. Existing `furnsh()`
   unchanged. New tests: a small in-memory/mock resolver exercising
   `load()`'s meta-kernel recursion and error paths, same
   synthetic-fixture style the existing suite already uses.
3. **Add the pluggable cache interface + IndexedDB default** (\S3.5,
   whole-file only -- not the block-based design in \S3.6 yet).
   `load(url, pool, { cache: defaultCache() })`.
4. **(Optional, later) block-aligned lazy/range loading** (\S3.6),
   once there's a real use case that needs to avoid downloading a
   whole large kernel.

Each phase is independently shippable and testable; nothing here
requires committing to the later phases up front.

## 7. Open questions

Resolved by review (recorded here for the record, not still open):

- **API naming**: `load()`, not `furnshAsync()` -- signals "the new,
  more general entry point" rather than implying exact parity with
  `furnsh_c`'s semantics (which it deliberately doesn't match, e.g. it
  understands caching and `furnsh_c` has no such concept). See \S3.4.
- **Reference proxy scope**: document a short example, don't ship or
  host one. See \S5.

Still open, need a decision before/at Phase 3:

- **Default cache backend**: IndexedDB (broadest support, right fit
  for the whole-file cache Phase 3 actually needs) vs. Cache API
  (better fit only if a same-origin proxy is also being built, so its
  `Response`-based revalidation is actually usable) -- see the table
  in \S3.5. Recommendation: IndexedDB for Phase 3; OPFS becomes the
  right choice specifically if/when \S3.6's block-based lazy loading
  is built, not before.
- **Bundle/package shape**: still ship as plain ESM source (as today,
  no build step) and let bundlers (Vite/webpack/esbuild) handle it
  directly -- or add a `browser` field / prebuilt bundle? Plain ESM
  (no `fs`/`Buffer` left anywhere after \S3.1-3.2) should just work
  with every modern bundler's default Node-polyfill-free browser
  target, so a prebuilt bundle probably isn't needed, but worth
  confirming against Vite once phase 1-2 land.
