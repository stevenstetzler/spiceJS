/**
 * toUint8Array(): normalizes anything byte-like -- a Node `Buffer`, a
 * plain `Uint8Array`/other typed-array view, or a raw `ArrayBuffer` --
 * into the canonical `Uint8Array` every reader in this codebase
 * (daf.js and everything built on it) assumes bytes arrive as. A
 * `fetch()` response's `.arrayBuffer()` in particular hands back a
 * plain `ArrayBuffer`, not a view, so this normalization has to
 * happen somewhere at the I/O boundary (load.js) rather than assuming
 * every caller already did it.
 */
export function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes; // covers Node's Buffer too (a Uint8Array subclass)
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new Error('expected a Uint8Array, ArrayBuffer, or ArrayBuffer view');
}
