/**
 * load(): the async, environment-agnostic sibling of furnsh() (see
 * docs/browser-support.md for the design). Where furnsh() only ever
 * reads a local file via Node's `fs` (synchronous, Node-only), load()
 * accepts an http(s) URL (fetched), a `File`/`Blob` (a browser local-
 * file picker or drag-and-drop selection), or raw bytes
 * (`ArrayBuffer`/`Uint8Array`) -- and, optionally, caches whatever it
 * fetches so a repeat load() of the same URL doesn't re-download it
 * (see cache.js).
 *
 * furnsh() itself is unchanged by this -- load() is a strictly
 * additive entry point, not a replacement, and has no Node-specific
 * import of its own (no `fs`, no `path`), so it -- and everything it
 * pulls in (kernelBytes.js, daf.js, spk.js, pck.js, textKernel.js,
 * metaKernel.js) -- is safe to bundle into a browser build.
 */
import { decodeKernel } from './kernelBytes.js';
import { toUint8Array } from './bytes.js';
import { globalPool } from './pool.js';
import { isUrlReference } from './kernelReference.js';

/**
 * The default byte resolver: `fetch()` for http(s) URL strings,
 * `.arrayBuffer()` for anything `Blob`-shaped (covers both `Blob` and
 * `File`), and a passthrough for raw `ArrayBuffer`/typed-array bytes.
 * Anything else is a clear error rather than a confusing one three
 * layers down -- pass a custom `resolve` option to handle other
 * reference shapes yourself (e.g. a Node local path via `fs`, or an
 * Electron IPC round trip to the main process).
 */
async function defaultResolve(reference) {
  if (isUrlReference(reference)) {
    const response = await fetch(reference);
    if (!response.ok) {
      throw new Error(`load: fetching "${reference}" failed with HTTP ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  if (reference && typeof reference.arrayBuffer === 'function') {
    // Blob/File (duck-typed, so this also accepts anything else that
    // happens to expose the same async arrayBuffer() shape).
    return new Uint8Array(await reference.arrayBuffer());
  }
  if (reference instanceof ArrayBuffer || ArrayBuffer.isView(reference)) {
    return toUint8Array(reference);
  }
  throw new Error(
    'load: don\'t know how to resolve the given reference into bytes -- pass an http(s) URL string, a ' +
      'File/Blob, raw ArrayBuffer/TypedArray bytes, or a custom `resolve` option that handles it.'
  );
}

/**
 * Resolve a meta-kernel's (possibly relative) sub-kernel reference
 * against the URL it was itself loaded from, the same way furnsh()
 * resolves a relative sub-kernel path against the meta-kernel's own
 * directory. If the meta-kernel wasn't loaded from a URL (e.g. it was
 * loaded from raw bytes, or via a custom `resolve`), there's no base
 * to resolve a relative reference against -- pass it through as-is
 * and let `resolve()` decide whether it can make sense of it.
 */
function resolveRelativeReference(rawReference, baseName) {
  if (isUrlReference(rawReference)) return rawReference; // already absolute
  if (isUrlReference(baseName)) return new URL(rawReference, baseName).href;
  return rawReference;
}

/**
 * Like furnsh(), but async and environment-agnostic: `reference` can
 * be an http(s) URL, a `File`/`Blob`, or raw bytes, instead of only a
 * local filesystem path. A kernel loaded via load() is unloadable via
 * unload() (and forgotten by kclear()) exactly like one loaded via
 * furnsh() -- both share the same per-pool load registry.
 *
 * @param {string|Blob|ArrayBuffer|ArrayBufferView} reference
 * @param {import('./pool.js').KernelPool} [pool]
 * @param {object} [options]
 * @param {(reference: any) => Promise<Uint8Array>|Uint8Array} [options.resolve] -
 *   overrides the default resolver entirely (URL/File/Blob/raw-bytes
 *   support included) -- provide your own if `reference` needs
 *   different handling (e.g. authenticated fetches, or a Node local
 *   path via `fs`).
 * @param {{ get(key: string): Promise<Uint8Array|null|undefined>, put(key: string, bytes: Uint8Array): Promise<void> }} [options.cache] -
 *   consulted (by `reference`, when it's a string) before resolving,
 *   and populated after a resolve that wasn't a cache hit -- see
 *   cache.js for ready-made implementations.
 */
export async function load(reference, pool = globalPool, options = {}) {
  const resolve = options.resolve ?? defaultResolve;
  const cache = options.cache ?? null;

  async function fetchAndLoad(ref) {
    const key = typeof ref === 'string' ? ref : null;
    let bytes = key && cache ? await cache.get(key) : null;
    if (!bytes) {
      bytes = toUint8Array(await resolve(ref));
      if (key && cache) await cache.put(key, bytes);
    }

    const name = key ?? '<bytes>';
    const result = decodeKernel(bytes, name, pool);
    if (result.isMeta) {
      for (const rawReference of result.kernelsToLoad) {
        await fetchAndLoad(resolveRelativeReference(rawReference, name));
      }
    }
  }

  await fetchAndLoad(reference);
}
