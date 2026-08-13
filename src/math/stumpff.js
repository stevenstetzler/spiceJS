/**
 * The Stumpff functions C0, C1, C2, C3, needed by the universal-
 * variables two-body propagator (src/prop2b.js). Faithfully
 * translated from NAIF's stmp03.c, not re-derived independently.
 *
 * Definition (converges for all real x):
 *
 *   C_k(x) = 1/k! - x/(k+2)! + x^2/(k+4)! - x^3/(k+6)! + ...
 *
 * For |x| > 1 this has an exact closed form (x > 0: circular/
 * trigonometric; x < 0: hyperbolic):
 *
 *   C0(x) = cos(sqrt(x)),        C1(x) = sin(sqrt(x))/sqrt(x)
 *   C2(x) = (1 - C0(x)) / x,     C3(x) = (1 - C1(x)) / x
 *
 * (with cosh/sinh(sqrt(-x)) for x < -1). For |x| <= 1, the closed
 * form above is numerically unstable (cancellation as x -> 0), so
 * stmp03.c instead evaluates C2/C3's Maclaurin series via a nested
 * ("Horner-style") nested-fraction nested evaluation using
 * `pairs[i] = 1/(i*(i+1))`, then gets C1/C0 from the exact recursion
 * `x*C_{k+2}(x) = 1/k! - C_k(x)`.
 */

// pairs[i] (0-indexed) = NAIF's PAIRS(i+1) = 1 / ((i+1)*(i+2)).
const PAIRS = Array.from({ length: 20 }, (_, i) => 1 / ((i + 1) * (i + 2)));

/**
 * @param {number} x
 * @returns {{ c0: number, c1: number, c2: number, c3: number }}
 */
export function stumpffFunctions(x) {
  if (x < -1) {
    const z = Math.sqrt(-x);
    const c0 = Math.cosh(z);
    const c1 = Math.sinh(z) / z;
    return { c0, c1, c2: (1 - c0) / x, c3: (1 - c1) / x };
  }
  if (x > 1) {
    const z = Math.sqrt(x);
    const c0 = Math.cos(z);
    const c1 = Math.sin(z) / z;
    return { c0, c1, c2: (1 - c0) / x, c3: (1 - c1) / x };
  }

  // |x| <= 1: nested series evaluation (stmp03.c's PAIRS(i) is
  // 1-indexed; PAIRS(i) here is PAIRS[i-1]).
  let c3 = 1;
  for (let i = 20; i >= 4; i -= 2) {
    c3 = 1 - x * PAIRS[i - 1] * c3;
  }
  c3 = PAIRS[1] * c3;

  let c2 = 1;
  for (let i = 19; i >= 3; i -= 2) {
    c2 = 1 - x * PAIRS[i - 1] * c2;
  }
  c2 = PAIRS[0] * c2;

  const c1 = 1 - x * c3;
  const c0 = 1 - x * c2;
  return { c0, c1, c2, c3 };
}
