/**
 * General-node-spacing Lagrange and Hermite polynomial interpolation,
 * used by SPK segment types 8/9 (Lagrange) and 12/13 (Hermite) --
 * type 8/12 use equally-spaced epochs, 9/13 arbitrary ones, but the
 * interpolating polynomial through a given set of (epoch, value)
 * pairs is the same polynomial either way (NAIF's LGRESP/HRMESP are
 * just faster shortcuts for the equally-spaced case, not a different
 * algorithm -- see LGRINT/HRMINT, the general-spacing routines they're
 * shortcuts of). spiceJS implements one general version of each and
 * reuses it for both segment types, verified against NAIF's own
 * worked example below and cross-checked against spiceypy.
 */

/**
 * The value at `x` of the unique degree-`xs.length-1` polynomial
 * passing through `(xs[i], ys[i])` -- Neville's algorithm (the
 * standard "Numerical Recipes" formulation NAIF's LGRESP/LGRINT cite
 * and use), generalized from NAIF's own equally-spaced LGRESP
 * recursion (`work[i] = ((xs[i+j]-x)*work[i] + (x-xs[i])*work[i+1]) /
 * (xs[i+j]-xs[i])`, which reduces to LGRESP's `((i+j-newx)*work[i] +
 * (newx-i)*work[i+1]) / j` exactly when the nodes are evenly spaced by
 * `step` and `newx = (x-xs[0])/step`).
 *
 * @param {number[]} xs - distinct abscissas (any order/spacing)
 * @param {number[]} ys - corresponding ordinates, same length as `xs`
 * @param {number} x
 * @returns {number}
 */
export function lagrangeInterpolate(xs, ys, x) {
  const n = xs.length;
  if (n === 0 || ys.length !== n) {
    throw new Error(`lagrangeInterpolate: xs/ys must be the same non-zero length (got ${n}, ${ys.length})`);
  }
  const work = ys.slice();
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < n - j; i++) {
      const denom = xs[i + j] - xs[i];
      if (denom === 0) {
        throw new Error(`lagrangeInterpolate: duplicate abscissa xs[${i}] === xs[${i + j}] === ${xs[i]}`);
      }
      work[i] = ((xs[i + j] - x) * work[i] + (x - xs[i]) * work[i + 1]) / denom;
    }
  }
  return work[0];
}

/**
 * The value and derivative at `x` of the unique degree-`2*xs.length-1`
 * polynomial matching both `(xs[i], ys[i])` and `dys[i]` (the
 * derivative at `xs[i]`) for every `i` -- the standard confluent/
 * Hermite divided-difference construction: each real node is treated
 * as a doubled ("repeated") node in an ordinary divided-difference
 * table, with the repeated-node first difference substituted by the
 * given derivative (since the ordinary difference quotient would
 * divide by zero) -- mathematically the same construction as NAIF's
 * HRMINT (a repeated-node extension of Neville's algorithm), evaluated
 * here via the equivalent Newton form for a simpler implementation.
 * Verified against HRMINT's own worked example in its doc comment
 * (see test/lagrangeHermite.test.js): fitting `(x,y,y') = (-1,6,3),
 * (0,5,0), (3,2210,5115), (5,78180,109395)` and evaluating at `x=2`
 * gives `141.0`/`456.0`, matching the closed form `f(x)=x^7+2x^2+5`.
 *
 * @param {number[]} xs - distinct abscissas
 * @param {number[]} ys - values at each abscissa
 * @param {number[]} dys - derivatives at each abscissa
 * @param {number} x
 * @returns {{ value: number, derivative: number }}
 */
export function hermiteInterpolate(xs, ys, dys, x) {
  const n = xs.length;
  if (n === 0 || ys.length !== n || dys.length !== n) {
    throw new Error('hermiteInterpolate: xs/ys/dys must all be the same non-zero length');
  }
  const m = 2 * n;

  // Each real node i doubles into virtual nodes 2i, 2i+1 at the same abscissa.
  const z = new Array(m);
  let column = new Array(m); // divided-difference column, order 0
  for (let i = 0; i < n; i++) {
    z[2 * i] = xs[i];
    z[2 * i + 1] = xs[i];
    column[2 * i] = ys[i];
    column[2 * i + 1] = ys[i];
  }

  const coeffs = [column[0]]; // Newton-form coefficients, one per divided-difference order

  // Order 1: repeated-node pairs (i even: z[2k] === z[2k+1] by
  // construction) use the given derivative directly (the ordinary
  // difference quotient would be 0/0); odd i is an ordinary divided
  // difference between two distinct real nodes.
  let next = new Array(m - 1);
  for (let i = 0; i < m - 1; i++) {
    if (i % 2 === 0) {
      next[i] = dys[i / 2];
    } else {
      const denom = z[i + 1] - z[i];
      if (denom === 0) {
        throw new Error(`hermiteInterpolate: duplicate abscissa xs[${(i - 1) / 2}] === xs[${(i + 1) / 2}] === ${z[i]}`);
      }
      next[i] = (column[i + 1] - column[i]) / denom;
    }
  }
  column = next;
  coeffs.push(column[0]);

  // Orders 2..m-1: ordinary divided differences (z[i+j] !== z[i] is
  // guaranteed once j >= 2, since repeats only ever occur in adjacent pairs).
  for (let j = 2; j < m; j++) {
    next = new Array(m - j);
    for (let i = 0; i < m - j; i++) {
      next[i] = (column[i + 1] - column[i]) / (z[i + j] - z[i]);
    }
    column = next;
    coeffs.push(column[0]);
  }

  // Evaluate the Newton-form polynomial and its derivative together via
  // nested (Horner-style) evaluation: P(x) = c0 + (x-z0)*(c1 + (x-z1)*(c2 + ...)).
  // d/dx of that nested form, computed alongside P itself (standard
  // simultaneous value+derivative Horner trick, generalized from a
  // fixed step to Newton's varying (x - z_k) factors).
  let value = coeffs[m - 1];
  let derivative = 0;
  for (let k = m - 2; k >= 0; k--) {
    derivative = derivative * (x - z[k]) + value;
    value = value * (x - z[k]) + coeffs[k];
  }

  return { value, derivative };
}
