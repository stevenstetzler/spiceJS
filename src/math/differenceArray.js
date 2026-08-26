/**
 * SPK type 21 (extended difference lines / Modified Difference
 * Arrays) -- the position/velocity evaluator, confirmed against
 * NAIF's real spke21.c (OpenSpace/Spice mirror). SPKE21 is a
 * generalized SPKE01 (the classic Type 1 evaluator): the same
 * modified-divided-difference recurrence, just sized off a
 * per-segment `MAXDIM` (<=25, see interpolatedRecord.js's
 * readDifferenceLine()) instead of a fixed compile-time `MAXTRM=15`.
 *
 * This is a genuinely different numerical method from every other
 * segment type spiceJS supports -- not Chebyshev (math/chebyshev.js),
 * not Lagrange/Hermite interpolation (math/lagrangeHermite.js), not
 * two-body propagation (prop2b.js) -- hence its own module, mirroring
 * how those each own their evaluator.
 */

/**
 * @param {object} record - one already-read "extended difference
 *   line" (interpolatedRecord.js's readDifferenceLine()):
 *   - `tl` (number): the record's own reference epoch
 *   - `g` (number[], length MAXDIM): stepsize function vector
 *   - `refPos`, `refVel` (number[3] each): reference state at `tl`
 *   - `dt` (number[3][MAXDIM]): modified divided-difference arrays,
 *     one per axis (X, Y, Z)
 *   - `kqmax1` (number): maximum integration order, plus 1
 *   - `kq` (number[3]): the integration order actually used per axis
 *     (each `<= kqmax1 - 1`)
 * @param {number} et
 * @returns {{ position: number[], velocity: number[] }}
 */
export function evaluateDifferenceLine(record, et) {
  const { tl, g, refPos, refVel, dt, kqmax1, kq } = record;

  const delta = et - tl;
  const mq2 = kqmax1 - 2;
  let ks = kqmax1 - 1;

  // fc/wc/w mirror spke21.c's own indexing exactly (down to the
  // Fortran-derived, 1-based-style access into fc -- fc[0] is an
  // unused dummy slot) rather than being reformulated into a
  // "cleaner" 0-based JS equivalent by hand: this is numerically
  // sensitive code translated directly from a real, working reference
  // implementation, and matching its indexing verbatim is the safest
  // way to avoid a subtle off-by-one slipping into a position/
  // velocity computation. Correctness is what crossval/ (real CSPICE,
  // via spiceypy) checks, not just internal consistency.
  const fc = new Array(mq2 + 1).fill(0);
  const wc = new Array(mq2 + 1).fill(0);
  // w only ever needs indices [0, kqmax1-1] (the recurrence's jx/ks
  // move oppositely by the same amount each iteration, so j+ks-1 stays
  // pinned at kqmax1-1 throughout -- but a little slack costs nothing).
  const w = new Array(kqmax1 + mq2 + 2).fill(0);

  let tp = delta;
  for (let j = 1; j <= mq2; j++) {
    fc[j] = tp / g[j - 1];
    wc[j - 1] = delta / g[j - 1];
    tp = delta + g[j - 1];
  }

  for (let j = 1; j <= kqmax1; j++) {
    w[j - 1] = 1 / j;
  }

  let jx = 0;
  let ks1 = ks - 1;
  while (ks >= 2) {
    jx++;
    for (let j = 1; j <= jx; j++) {
      w[j + ks - 1] = fc[j] * w[j + ks1 - 1] - wc[j - 1] * w[j + ks - 1];
    }
    ks = ks1;
    ks1--;
  }

  const position = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const kqq = kq[axis];
    let sum = 0;
    for (let j = kqq; j >= 1; j--) {
      sum += dt[axis][j - 1] * w[j + ks - 1];
    }
    position[axis] = refPos[axis] + delta * (refVel[axis] + delta * sum);
  }

  // One more level of the same recurrence -- spke21.c recomputes W
  // once further (using the same fc/wc, one more (j, ks) step) before
  // summing again for velocity, rather than reusing the position
  // pass's W outright.
  for (let j = 1; j <= jx; j++) {
    w[j + ks - 1] = fc[j] * w[j + ks1 - 1] - wc[j - 1] * w[j + ks - 1];
  }
  ks--;

  const velocity = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const kqq = kq[axis];
    let sum = 0;
    for (let j = kqq; j >= 1; j--) {
      sum += dt[axis][j - 1] * w[j + ks - 1];
    }
    velocity[axis] = refVel[axis] + delta * sum;
  }

  return { position, velocity };
}
