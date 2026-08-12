/**
 * The kernel pool: an in-memory store of named variables loaded from
 * text kernels (LSK, PCK, FK, IK, SCLK, ...), mirroring the "kernel
 * pool" concept in NAIF's SPICE toolkit (see the POOL required
 * reading, and routines like PDPOOL/PCPOOL/GDPOOL/GCPOOL) -- plus an
 * index of segments loaded from binary SPK (trajectory) kernels. Text
 * variables and SPK segments are unrelated data, but both are "what
 * furnsh() has loaded so far", so this class holds both rather than
 * threading a second piece of state through furnsh()/unload()/every
 * query function.
 */
export class KernelPool {
  constructor() {
    /** @type {Map<string, Array<string|number>>} */
    this._vars = new Map();
    /** @type {Map<number, Array<object>>} target body ID -> SPK segments */
    this._spkSegmentsByTarget = new Map();
    /** @type {Map<number, Array<object>>} frame ID -> PCK segments */
    this._pckSegmentsByFrame = new Map();
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

  /** Index SPK segments (see spk.js's loadSpk()) by their target body ID. */
  addSpkSegments(segments) {
    for (const segment of segments) {
      const list = this._spkSegmentsByTarget.get(segment.target);
      if (list) {
        list.push(segment);
      } else {
        this._spkSegmentsByTarget.set(segment.target, [segment]);
      }
    }
  }

  /** Undo addSpkSegments() for exactly these segment objects (used by unload()). */
  removeSpkSegments(segments) {
    for (const segment of segments) {
      const list = this._spkSegmentsByTarget.get(segment.target);
      if (!list) continue;
      const idx = list.indexOf(segment);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this._spkSegmentsByTarget.delete(segment.target);
    }
  }

  /** Loaded SPK segments with the given target body ID (empty array if none). */
  getSpkSegments(target) {
    return this._spkSegmentsByTarget.get(target) || [];
  }

  /** Every loaded SPK segment, across all target bodies. */
  allSpkSegments() {
    return Array.from(this._spkSegmentsByTarget.values()).flat();
  }

  /** Index PCK segments (see pck.js's loadPck()) by their frame ID. */
  addPckSegments(segments) {
    for (const segment of segments) {
      const list = this._pckSegmentsByFrame.get(segment.frame);
      if (list) {
        list.push(segment);
      } else {
        this._pckSegmentsByFrame.set(segment.frame, [segment]);
      }
    }
  }

  /** Undo addPckSegments() for exactly these segment objects (used by unload()). */
  removePckSegments(segments) {
    for (const segment of segments) {
      const list = this._pckSegmentsByFrame.get(segment.frame);
      if (!list) continue;
      const idx = list.indexOf(segment);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this._pckSegmentsByFrame.delete(segment.frame);
    }
  }

  /** Loaded PCK segments with the given frame ID (empty array if none). */
  getPckSegments(frameId) {
    return this._pckSegmentsByFrame.get(frameId) || [];
  }

  /** Every loaded PCK segment, across all frames. */
  allPckSegments() {
    return Array.from(this._pckSegmentsByFrame.values()).flat();
  }

  /** Remove every variable, SPK segment, and PCK segment from the pool (as in SPICE's kclear_c). */
  clear() {
    this._vars.clear();
    this._spkSegmentsByTarget.clear();
    this._pckSegmentsByFrame.clear();
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
