/**
 * Shared definition of "is this reference a URL" -- used by both
 * kernels.js (so unload()'s key resolution doesn't mangle a URL that
 * load() registered verbatim through Node's path.resolve()) and
 * load.js (to decide whether to fetch a reference directly or resolve
 * it as relative to a base URL). Kept in one place so both sides
 * agree on exactly the same definition -- a mismatch here would mean
 * a kernel loaded via load() silently becomes un-unloadable.
 */
export function isUrlReference(reference) {
  return typeof reference === 'string' && /^https?:\/\//i.test(reference);
}
