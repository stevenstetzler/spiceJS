/**
 * The environment-agnostic core every specific lazy-query type builds
 * on (`prefetchSpkQuery()` below; PCK's `pckPrefetch.js`'s
 * `prefetchPckQuery()`): discover the file's structure (cheap, and
 * shared across every query against the same file), ask `findSegments`
 * which segment descriptors are needed, and `ensureRange()` exactly
 * the bytes each one's evaluation over `[etStart, etEnd]` will touch.
 * SPK and PCK differ only in *how* the needed segments are found --
 * SPK via `spkez(target, observer, ...)`'s pair of independent chains
 * to the Solar System Barycenter, PCK via a direct frame-ID lookup
 * (no chaining concept at all) -- so that's the one thing left to the
 * caller; everything else (structural discovery, byte-range
 * computation, idempotent registration) is identical either way. See
 * `docs/lazy-loading.md` for the full design.
 *
 * Once a `prefetch...Query()` call resolves, `pool` behaves exactly
 * like a pool `furnsh()`/`load()` populated -- ordinary, synchronous
 * `spkez()`/`spkState()`/`rotateState()` calls against it work
 * unmodified.
 */
import { parseFileRecord, parseDaf, readWords, FILE_RECORD_BYTES } from '../daf.js';
import { summaryToSpkSegment } from '../spk.js';
import { byteRangeForQuery } from './byteRange.js';

const SSB = 0; // mirrors spk.js's own SSB constant
const MAX_CHAIN_HOPS = 20; // mirrors spk.js's own MAX_CHAIN_HOPS (matches NAIF's CHLEN, spkgeo.f)
const WORDS_PER_RECORD = FILE_RECORD_BYTES / 8; // 128 -- DAF records are 1024 bytes = 128 double-precision words

/**
 * Fetch exactly the summary records `parseDaf()` will walk, by walking
 * that same chain here one 1024-byte record at a time -- each record's
 * first word is the record number of the next one (0 = end), so the
 * chain can only be discovered incrementally, never predicted.
 *
 * The obvious-looking alternative -- one bulk `ensureRange()` from
 * FWARD to BWARD (the first and last summary records, both named right
 * in the file record) -- is what this used to do, and it's a trap: it
 * fetches the whole *span* between them, not just the records
 * themselves. That's harmless for the common layout where summary
 * records cluster at the front of the file, but catastrophic when
 * they're scattered through it. Measured against the real, live
 * `ura184_part-3.bsp` (386.9 MB): the bulk range pulled **334 MB**
 * (86% of the entire file) where walking the chain pulls ~4 blocks --
 * i.e. the bulk version silently defeated the whole point of lazy
 * loading on exactly the kind of big file it exists to serve. Every
 * other kernel tested (de440, de440s, mar099, jup365, nep105, plu060,
 * sat480, ura184 parts 1-2) was unaffected either way, which is
 * precisely why this went unnoticed until a file with a scattered
 * layout showed up.
 *
 * @param {import('./remoteFile.js').RemoteFile} remoteFile
 * @param {{ fward: number, littleEndian: boolean }} fileRecord
 */
async function ensureSummaryRecords(remoteFile, fileRecord) {
  let recordNumber = fileRecord.fward;
  const visited = new Set();
  while (recordNumber !== 0) {
    if (visited.has(recordNumber)) {
      throw new Error(`prefetchQuery: summary record chain loops back to record ${recordNumber}`);
    }
    visited.add(recordNumber);

    const startByte = (recordNumber - 1) * FILE_RECORD_BYTES;
    await remoteFile.ensureRange(startByte, startByte + FILE_RECORD_BYTES);

    // The record's first word is NEXT: the next summary record's
    // number, or 0 at the end of the chain.
    const firstWordAddr = (recordNumber - 1) * WORDS_PER_RECORD + 1; // readWords() addresses are 1-based
    const [next] = readWords(remoteFile.buffer, fileRecord.littleEndian, firstWordAddr, firstWordAddr);
    recordNumber = Math.round(next);
  }
}

function dedupeByStartAddr(segments) {
  const seen = new Set();
  const out = [];
  for (const segment of segments) {
    if (seen.has(segment.startAddr)) continue;
    seen.add(segment.startAddr);
    out.push(segment);
  }
  return out;
}

/**
 * @param {import('./remoteFile.js').RemoteFile} remoteFile
 * @param {object} options
 * @param {(summaries: Array<{dc: number[], ic: number[]}>, marginedStart: number, marginedEnd: number) => object[]} options.findSegments -
 *   returns the segment descriptors needed (without `buffer`/
 *   `littleEndian` -- attached here, uniformly)
 * @param {(segments: object[]) => void} options.addSegments - registers the (already deduped, buffer/littleEndian-attached) segments
 * @param {number} options.etStart
 * @param {number} options.etEnd
 * @param {number} options.lightTimeMargin
 */
export async function prefetchQuery(remoteFile, { findSegments, addSegments, etStart, etEnd, lightTimeMargin }) {
  if (etStart > etEnd) {
    throw new Error(`prefetchQuery: etStart (${etStart}) must be <= etEnd (${etEnd})`);
  }

  await remoteFile.ensureRange(0, FILE_RECORD_BYTES);
  const fileRecord = parseFileRecord(remoteFile.buffer);
  await ensureSummaryRecords(remoteFile, fileRecord);
  const daf = parseDaf(remoteFile.buffer);

  const marginedStart = etStart - lightTimeMargin;
  const marginedEnd = etEnd + lightTimeMargin;

  // .buffer/.littleEndian attached now, not just when adding to a
  // pool -- byteRangeForQuery() (via chebyshevRecord.js's
  // readEpilog()/selectRecord(), or interpolatedRecord.js's
  // equivalents) needs them to read a segment's own epilog, same as
  // ordinary evaluateSegment() does.
  const segments = dedupeByStartAddr(findSegments(daf.summaries, marginedStart, marginedEnd)).map((segment) => ({
    ...segment,
    buffer: remoteFile.buffer,
    littleEndian: daf.littleEndian,
  }));

  for (const segment of segments) {
    const range = await byteRangeForQuery(remoteFile, segment, marginedStart, marginedEnd);
    await remoteFile.ensureRange(range.startByte, range.endByteExclusive);
  }

  addSegments(segments);
}

function overlapsQuery(segment, etStart, etEnd) {
  return segment.stopEt >= etStart && segment.startEt <= etEnd;
}

/**
 * Every segment (in file/summary order) that could plausibly be
 * picked for `bodyId` somewhere in `[etStart, etEnd]` -- may be more
 * than one if segments with overlapping coverage exist, mirroring
 * `spk.js`'s `pickSegmentForBody()`'s "last one wins" tie-break for a
 * single `et`: adding every overlapping candidate, in file order, to
 * the pool reproduces that same tie-break for any `et` actually
 * queried later, without prefetch.js needing to replicate the
 * per-`et` picking logic itself.
 */
function segmentsForBody(summaries, bodyId, etStart, etEnd) {
  return summaries
    .map(summaryToSpkSegment)
    .filter((segment) => segment.target === bodyId && overlapsQuery(segment, etStart, etEnd));
}

/**
 * The chain of segments from `bodyId` down to the SSB (body 0) --
 * mirrors `spk.js`'s own `chainStateToSsb()`, against raw summaries
 * instead of a live pool.
 */
function findChainToSsb(summaries, bodyId, etStart, etEnd) {
  const chain = [];
  let current = bodyId;
  const visited = new Set();
  while (current !== SSB) {
    if (visited.has(current)) {
      throw new Error(`prefetchSpkQuery: circular SPK center chain detected -- body ${current} is its own ancestor`);
    }
    if (visited.size >= MAX_CHAIN_HOPS) {
      throw new Error(
        `prefetchSpkQuery: center chain for body ${bodyId} did not reach the Solar System Barycenter (body 0) ` +
          `within ${MAX_CHAIN_HOPS} hops`
      );
    }
    visited.add(current);

    const candidates = segmentsForBody(summaries, current, etStart, etEnd);
    if (candidates.length === 0) {
      throw new Error(
        `prefetchSpkQuery: no segment found for body ${current} (needed to chain body ${bodyId} to the Solar ` +
          `System Barycenter) covering [${etStart}, ${etEnd}]`
      );
    }
    chain.push(...candidates);
    current = candidates[candidates.length - 1].center;
  }
  return chain;
}

/** Adds only the segments `pool` doesn't already have (by buffer + startAddr) -- makes repeated prefetch() calls idempotent. */
function addSpkSegmentsIfMissing(pool, segments) {
  const toAdd = segments.filter((segment) => {
    const existing = pool.getSpkSegments(segment.target);
    return !existing.some((e) => e.buffer === segment.buffer && e.startAddr === segment.startAddr);
  });
  if (toAdd.length) pool.addSpkSegments(toAdd);
}

/**
 * Fetch (into `remoteFile`, and register into `pool`) exactly what's
 * needed to answer `spkez(target, observer, et, ...)` for any `et` in
 * `[etStart, etEnd]` -- SPK's own `findSegments`/`addSegments` for
 * `prefetchQuery()` above: `target` and `observer` each get their own
 * independent chain to the SSB (this is *not* "target down to a
 * single center", since `spkez()` needs both bodies' own chains, not
 * one chain between them, except in the special case where `observer`
 * already sits on `target`'s own chain).
 *
 * @param {import('./remoteFile.js').RemoteFile} remoteFile
 * @param {import('../pool.js').KernelPool} pool
 * @param {object} query
 * @param {number} query.target
 * @param {number} query.observer
 * @param {number} query.etStart
 * @param {number} query.etEnd
 * @param {number} [query.lightTimeMargin] - widens `[etStart, etEnd]`
 *   by this many seconds on each side before computing byte ranges,
 *   to cover a light-time-corrected `spkez()` call's `et ± lightTime`
 *   iteration landing outside the nominal window. Real light times
 *   within the solar system range from ~8 minutes (Sun-Earth) to
 *   several *hours* for the outer planets (Neptune: ~4.2 light-hours;
 *   Pluto: up to ~6.5) -- there's no safe one-size-fits-all default
 *   here, so this has no default beyond `0` (meaning "no light-time
 *   correction expected"); pick a margin appropriate to the bodies
 *   and correction actually being used.
 */
export async function prefetchSpkQuery(remoteFile, pool, { target, observer, etStart, etEnd, lightTimeMargin = 0 }) {
  await prefetchQuery(remoteFile, {
    etStart,
    etEnd,
    lightTimeMargin,
    findSegments: (summaries, marginedStart, marginedEnd) => {
      const targetChain = findChainToSsb(summaries, target, marginedStart, marginedEnd);
      const observerChain =
        observer === target ? [] : findChainToSsb(summaries, observer, marginedStart, marginedEnd);
      return [...targetChain, ...observerChain];
    },
    addSegments: (segments) => addSpkSegmentsIfMissing(pool, segments),
  });
}

/**
 * Fetch (into `remoteFile`, and register into `pool`) just `bodyId`'s
 * own segment(s) covering `[etStart, etEnd]` -- one hop, no
 * chain-to-SSB requirement, unlike `prefetchSpkQuery()` above.
 *
 * The motivating case: a kernel whose only segment for a body is
 * relative to some *external* center (the Sun, say, or Earth) rather
 * than the Solar System Barycenter directly -- common for real
 * small-body/spacecraft SPK products (heliocentric states), and the
 * norm rather than the exception. `prefetchSpkQuery()` requires the
 * *whole* chain to the SSB to exist within one file (`findChainToSsb()`
 * only ever walks `remoteFile`'s own summaries), so it fails outright
 * on a kernel like that even when the missing link (the center's own
 * chain to the SSB) is already sitting in `pool` from a different,
 * already-loaded file -- `KernelPool` segments are file-agnostic, so
 * `spkez()`/`spkState()` would happily complete the chain across both
 * files once both halves are registered. This is the other half: fetch
 * just the local hop, and leave completing the chain to whatever else
 * has (or hasn't) already populated `pool` -- callers that need to
 * know whether the full chain now resolves should follow up with an
 * ordinary `spkState()`/`spkez()` call and let it fail clearly if not
 * (see `examples/browser-demo/index.html`'s "Add a custom kernel" for
 * exactly this pattern).
 *
 * @param {import('./remoteFile.js').RemoteFile} remoteFile
 * @param {import('../pool.js').KernelPool} pool
 * @param {object} query
 * @param {number} query.bodyId
 * @param {number} query.etStart
 * @param {number} query.etEnd
 * @param {number} [query.lightTimeMargin]
 */
export async function prefetchSpkBodySegment(remoteFile, pool, { bodyId, etStart, etEnd, lightTimeMargin = 0 }) {
  await prefetchQuery(remoteFile, {
    etStart,
    etEnd,
    lightTimeMargin,
    findSegments: (summaries, marginedStart, marginedEnd) => {
      const segments = segmentsForBody(summaries, bodyId, marginedStart, marginedEnd);
      if (segments.length === 0) {
        throw new Error(`prefetchSpkBodySegment: no segment found for body ${bodyId} covering [${etStart}, ${etEnd}]`);
      }
      return segments;
    },
    addSegments: (segments) => addSpkSegmentsIfMissing(pool, segments),
  });
}
