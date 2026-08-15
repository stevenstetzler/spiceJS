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
import { parseFileRecord, parseDaf, FILE_RECORD_BYTES } from '../daf.js';
import { summaryToSpkSegment } from '../spk.js';
import { byteRangeForQuery } from './byteRange.js';

const SSB = 0; // mirrors spk.js's own SSB constant
const MAX_CHAIN_HOPS = 20; // mirrors spk.js's own MAX_CHAIN_HOPS (matches NAIF's CHLEN, spkgeo.f)

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
  await remoteFile.ensureRange((fileRecord.fward - 1) * FILE_RECORD_BYTES, fileRecord.bward * FILE_RECORD_BYTES);
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
