/**
 * The kernel pool: an in-memory store of named variables loaded from
 * text kernels (LSK, PCK, FK, IK, SCLK, ...), mirroring the "kernel
 * pool" concept in NAIF's SPICE toolkit (see the POOL required
 * reading, and routines like PDPOOL/PCPOOL/GDPOOL/GCPOOL).
 *
 * Every pool variable is an array of values (strings and/or numbers),
 * even single-valued ones -- this matches how SPICE itself stores
 * pool variables.
 */
export class KernelPool {
  constructor() {
    /** @type {Map<string, Array<string|number>>} */
    this._vars = new Map();
  }

  /**
   * Assign (or append to) a pool variable.
   *
   * @param {string} name
   * @param {Array<string|number>|string|number} values
   * @param {boolean} [append] - true for SPICE's `+=` continuation operator
   */
  putValues(name, values, append = false) {
    const arr = Array.isArray(values) ? values.slice() : [values];
    if (append && this._vars.has(name)) {
      this._vars.get(name).push(...arr);
    } else {
      this._vars.set(name, arr);
    }
  }

  /**
   * Fetch a pool variable's values, or `undefined` if it isn't set.
   * Returns a copy -- callers cannot mutate pool state through it.
   *
   * @param {string} name
   * @returns {Array<string|number>|undefined}
   */
  getValues(name) {
    const v = this._vars.get(name);
    return v ? v.slice() : undefined;
  }

  has(name) {
    return this._vars.has(name);
  }

  deleteVar(name) {
    this._vars.delete(name);
  }

  /** All currently-defined pool variable names. */
  names() {
    return Array.from(this._vars.keys());
  }

  /** Remove every variable from the pool (as in SPICE's kclear_c). */
  clear() {
    this._vars.clear();
  }
}

/**
 * The default, module-level kernel pool. Most callers can ignore that
 * this exists at all and just use furnsh()/str2et() from index.js,
 * which default to it -- exactly like SPICE's own implicit global
 * kernel pool. Pass an explicit `pool` argument anywhere one is
 * accepted to keep kernel state isolated (e.g. in tests).
 */
export const globalPool = new KernelPool();
