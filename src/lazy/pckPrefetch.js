/**
 * PCK's `findSegments`/`addSegments` for `prefetch.js`'s
 * `prefetchQuery()` -- a direct frame-ID lookup, not a chain (PCK
 * segments give one frame's own orientation directly; there's no
 * "center" concept to walk the way SPK's target/observer chains do).
 * `byteRangeForQuery()` needs no PCK-specific case at all: PCK's only
 * supported segment type (2, Chebyshev) is byte-for-byte the same
 * addressing as SPK's, so the existing type-2/3 handler already
 * covers it (see `pck.js`'s own doc comment on why).
 */
import { summaryToPckSegment } from '../pck.js';
import { prefetchQuery } from './prefetch.js';

function overlapsQuery(segment, etStart, etEnd) {
  return segment.stopEt >= etStart && segment.startEt <= etEnd;
}

function segmentsForFrame(summaries, frame, etStart, etEnd) {
  return summaries
    .map(summaryToPckSegment)
    .filter((segment) => segment.frame === frame && overlapsQuery(segment, etStart, etEnd));
}

/** Adds only the segments `pool` doesn't already have (by buffer + startAddr) -- makes repeated prefetch() calls idempotent. */
function addPckSegmentsIfMissing(pool, segments) {
  const toAdd = segments.filter((segment) => {
    const existing = pool.getPckSegments(segment.frame);
    return !existing.some((e) => e.buffer === segment.buffer && e.startAddr === segment.startAddr);
  });
  if (toAdd.length) pool.addPckSegments(toAdd);
}

/**
 * Fetch (into `remoteFile`, and register into `pool`) exactly what's
 * needed to answer `rotateState()`/`frames.js`'s body-fixed-frame
 * orientation lookups for `frame` at any `et` in `[etStart, etEnd]`.
 *
 * @param {import('./remoteFile.js').RemoteFile} remoteFile
 * @param {import('../pool.js').KernelPool} pool
 * @param {object} query
 * @param {number} query.frame - the NAIF frame ID (e.g. 31008 for MOON_PA_DE440)
 * @param {number} query.etStart
 * @param {number} query.etEnd
 * @param {number} [query.lightTimeMargin] - see `prefetchSpkQuery()`'s doc comment
 */
export async function prefetchPckQuery(remoteFile, pool, { frame, etStart, etEnd, lightTimeMargin = 0 }) {
  await prefetchQuery(remoteFile, {
    etStart,
    etEnd,
    lightTimeMargin,
    findSegments: (summaries, marginedStart, marginedEnd) => segmentsForFrame(summaries, frame, marginedStart, marginedEnd),
    addSegments: (segments) => addPckSegmentsIfMissing(pool, segments),
  });
}
