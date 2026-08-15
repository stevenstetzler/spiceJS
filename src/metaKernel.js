/**
 * Environment-agnostic parsing of a meta-kernel's (KPL/MK) own
 * PATH_SYMBOLS/PATH_VALUES/KERNELS_TO_LOAD directives -- the pure
 * "what does this meta-kernel say to load" step, with the
 * `$SYMBOL`-substitution already applied. Deliberately doesn't know
 * whether the resulting references are filesystem paths or URLs, or
 * how to resolve a relative one against the meta-kernel's own
 * location -- that's environment-specific (kernels.js's furnsh() uses
 * Node's `path`; load.js's load() uses the `URL` constructor), so it
 * happens in the caller, not here.
 */
import { KernelPool } from './pool.js';
import { loadTextKernel } from './textKernel.js';

export function substitutePathSymbols(reference, symbolMap) {
  return reference.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (whole, symbol) =>
    symbolMap.has(symbol) ? symbolMap.get(symbol) : whole
  );
}

/**
 * @param {string} content - the meta-kernel's own text
 * @returns {{ kernelsToLoad: string[] }} `KERNELS_TO_LOAD`, with
 *   `PATH_SYMBOLS`/`PATH_VALUES` substitution already applied to each
 *   entry -- still possibly relative, still un-resolved.
 */
export function parseMetaKernel(content) {
  // A meta-kernel's own PATH_SYMBOLS/PATH_VALUES/KERNELS_TO_LOAD
  // variables are scratch data, not meant to land in the real kernel
  // pool -- parse them into a throwaway pool instead.
  const scratch = new KernelPool();
  loadTextKernel(content, scratch);

  const symbols = scratch.getValues('PATH_SYMBOLS') || [];
  const values = scratch.getValues('PATH_VALUES') || [];
  const symbolMap = new Map(symbols.map((s, i) => [s, values[i]]));
  const kernelsToLoad = (scratch.getValues('KERNELS_TO_LOAD') || []).map((rawReference) =>
    substitutePathSymbols(String(rawReference), symbolMap)
  );

  return { kernelsToLoad };
}
