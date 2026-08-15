/**
 * A lazily-fetched, block-aligned, population-tracked view of a
 * remote binary kernel file -- the foundation `docs/lazy-loading.md`
 * scopes out (§"Phase 1"). `ensureRange()` fetches exactly the byte
 * ranges it's asked for (coalescing adjacent misses, checking `cache`
 * first) into a single, real, `fileLength`-sized `Uint8Array`; nothing
 * else in this codebase needs to change to read it -- `daf.js`'s
 * `toDataView()`/`decodeLatin1()` already look for an optional
 * `.checkRange` method on whatever buffer they're given (see daf.js's
 * doc comment) and validate every read against it, so a read that
 * touches a byte this file was never asked to fetch throws a clear,
 * catchable error instead of silently returning zeros.
 *
 * This module has no opinion about DAF/SPK/PCK semantics at all --
 * `prefetch.js` is what decides *which* ranges a given query needs;
 * this just knows how to fetch and remember byte ranges of one file.
 */

const DEFAULT_BLOCK_BYTES = 65536; // 64 KiB -- see docs/browser-support.md §3.6

async function defaultResolveRange(url, startByte, endByteExclusive) {
  const response = await fetch(url, { headers: { Range: `bytes=${startByte}-${endByteExclusive - 1}` } });
  if (!response.ok) {
    throw new Error(
      `openRemoteFile: fetching "${url}" range [${startByte}, ${endByteExclusive}) failed with HTTP ` +
        `${response.status} ${response.statusText}`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function defaultGetFileLength(url) {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) {
    throw new Error(`openRemoteFile: HEAD "${url}" failed with HTTP ${response.status} ${response.statusText}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength == null) {
    throw new Error(
      `openRemoteFile: HEAD "${url}" did not return a Content-Length header -- pass \`fileLength\` explicitly`
    );
  }
  return Number(contentLength);
}

/** Group a sorted, deduplicated array of block indices into contiguous runs, e.g. [2,3,4,7] -> [[2,4],[7,7]]. */
function coalesceRuns(blockIndices) {
  const runs = [];
  for (const b of blockIndices) {
    const last = runs[runs.length - 1];
    if (last && last.end === b - 1) {
      last.end = b;
    } else {
      runs.push({ start: b, end: b });
    }
  }
  return runs;
}

export class RemoteFile {
  constructor(url, fileLength, { cache = null, blockBytes = DEFAULT_BLOCK_BYTES, resolveRange = defaultResolveRange } = {}) {
    this.url = url;
    this.fileLength = fileLength;
    this.blockBytes = blockBytes;
    this.cache = cache;
    this.resolveRange = resolveRange;
    this.populatedBlocks = new Set();

    // Every read against this buffer -- including ones made deep
    // inside spk.js/pck.js/chebyshevRecord.js/interpolatedRecord.js
    // during an ordinary, unmodified spkez() call, not just this
    // file's own ensureRange() calls -- goes through checkRange()
    // first (see daf.js's toDataView()/decodeLatin1()).
    this.buffer = new Uint8Array(fileLength);
    this.buffer.checkRange = (startByte, endByteExclusive) => this._checkRange(startByte, endByteExclusive);
  }

  blockIndexOf(byte) {
    return Math.floor(byte / this.blockBytes);
  }

  blockByteRange(blockIndex) {
    const startByte = blockIndex * this.blockBytes;
    return { startByte, endByteExclusive: Math.min(this.fileLength, startByte + this.blockBytes) };
  }

  cacheKeyForBlock(blockIndex) {
    return `${this.url}#block=${blockIndex}`;
  }

  isPopulated(startByte, endByteExclusive) {
    if (startByte >= endByteExclusive) return true;
    const firstBlock = this.blockIndexOf(startByte);
    const lastBlock = this.blockIndexOf(endByteExclusive - 1);
    for (let b = firstBlock; b <= lastBlock; b++) {
      if (!this.populatedBlocks.has(b)) return false;
    }
    return true;
  }

  _checkRange(startByte, endByteExclusive) {
    if (!this.isPopulated(startByte, endByteExclusive)) {
      throw new Error(
        `RemoteFile: byte range [${startByte}, ${endByteExclusive}) of "${this.url}" was not prefetched -- ` +
          'widen the query window (or the light-time margin) passed to prefetch() and retry.'
      );
    }
  }

  /**
   * Fetch (or serve from `cache`) whatever's needed so every byte in
   * `[startByte, endByteExclusive)` is populated in `this.buffer`.
   * Idempotent -- already-populated blocks are never re-fetched.
   */
  async ensureRange(startByte, endByteExclusive) {
    // Number.isFinite() also rejects NaN -- guards against a caller
    // accidentally deriving a range from an unset/undefined segment
    // field (e.g. a missing `endAddr`) and silently doing nothing
    // useful instead of failing clearly right here.
    if (!Number.isFinite(startByte) || !Number.isFinite(endByteExclusive)) {
      throw new Error(`RemoteFile: byte range [${startByte}, ${endByteExclusive}) is not a valid finite range`);
    }
    if (startByte < 0 || endByteExclusive > this.fileLength) {
      throw new Error(
        `RemoteFile: byte range [${startByte}, ${endByteExclusive}) is outside "${this.url}"'s ` +
          `${this.fileLength}-byte extent`
      );
    }
    if (startByte >= endByteExclusive) return; // zero-length range: nothing to do

    const firstBlock = this.blockIndexOf(startByte);
    const lastBlock = this.blockIndexOf(endByteExclusive - 1);
    const missing = [];
    for (let b = firstBlock; b <= lastBlock; b++) {
      if (!this.populatedBlocks.has(b)) missing.push(b);
    }
    if (missing.length === 0) return;

    // Cache first, per missing block -- whatever the cache doesn't
    // have either gets fetched over the network below.
    const stillMissing = [];
    for (const b of missing) {
      const cached = this.cache ? await this.cache.get(this.cacheKeyForBlock(b)) : null;
      if (cached) {
        this._writeBlock(b, cached);
      } else {
        stillMissing.push(b);
      }
    }
    if (stillMissing.length === 0) return;

    // Coalesce adjacent network misses into as few Range GETs as
    // possible (see docs/browser-support.md §3.6's motivation for
    // fixed-size blocks in the first place).
    for (const run of coalesceRuns(stillMissing)) {
      const { startByte: runStart } = this.blockByteRange(run.start);
      const { endByteExclusive: runEnd } = this.blockByteRange(run.end);
      const bytes = await this.resolveRange(this.url, runStart, runEnd);
      this.buffer.set(bytes, runStart);
      for (let b = run.start; b <= run.end; b++) {
        this.populatedBlocks.add(b);
        if (this.cache) {
          const { startByte: blockStart, endByteExclusive: blockEnd } = this.blockByteRange(b);
          await this.cache.put(this.cacheKeyForBlock(b), this.buffer.subarray(blockStart, blockEnd));
        }
      }
    }
  }

  _writeBlock(blockIndex, bytes) {
    const { startByte } = this.blockByteRange(blockIndex);
    this.buffer.set(bytes, startByte);
    this.populatedBlocks.add(blockIndex);
  }
}

/**
 * Open a lazily-fetched remote file -- fetches nothing yet beyond
 * (by default) learning its total length via `HEAD`; call
 * `ensureRange()` (directly, or via `prefetch.js`'s higher-level
 * `prefetchSpkQuery()`) to actually populate any of it.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.fileLength] - skip the `HEAD` request and use this instead
 * @param {(url: string) => Promise<number>} [options.getFileLength] - overrides the default `HEAD`-based lookup
 * @param {(url: string, startByte: number, endByteExclusive: number) => Promise<Uint8Array>} [options.resolveRange] -
 *   overrides the default `fetch()`-with-`Range`-header implementation (e.g. for a Node local-file range reader, or a test double)
 * @param {{ get(key: string): Promise<Uint8Array|null|undefined>, put(key: string, bytes: Uint8Array): Promise<void> }} [options.cache]
 * @param {number} [options.blockBytes]
 * @returns {Promise<RemoteFile>}
 */
export async function openRemoteFile(url, options = {}) {
  const { fileLength, getFileLength = defaultGetFileLength, ...rest } = options;
  const length = fileLength ?? (await getFileLength(url));
  return new RemoteFile(url, length, rest);
}
