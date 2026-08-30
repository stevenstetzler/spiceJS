/**
 * Chebyshev polynomial (first kind) evaluation, used to decode SPK
 * Type 2/3 segments: a value is `sum(coeffs[k] * T_k(s))` for `s` in
 * [-1, 1], via the standard recurrence
 *   T_0(s) = 1, T_1(s) = s, T_k(s) = 2*s*T_{k-1}(s) - T_{k-2}(s)
 *
 * The derivative with respect to `s` uses the identity
 *   d/ds T_k(s) = k * U_{k-1}(s)
 * where U is the Chebyshev polynomial of the second kind, via its own
 * analogous recurrence (U_{-1} = 0, U_0 = 1).
 */

/** sum(coeffs[k] * T_k(s)) */
export function evaluate(coeffs, s) {
  const n = coeffs.length - 1;
  let value = coeffs[0];
  if (n < 1) return value;

  let tPrev = 1;
  let tCurr = s;
  value += coeffs[1] * tCurr;
  for (let k = 2; k <= n; k++) {
    const tNext = 2 * s * tCurr - tPrev;
    value += coeffs[k] * tNext;
    tPrev = tCurr;
    tCurr = tNext;
  }
  return value;
}

/** { value, derivative }: the series value and its derivative with respect to `s`, in one pass. */
export function evaluateWithDerivative(coeffs, s) {
  const n = coeffs.length - 1;
  let value = coeffs[0];
  let derivative = 0;
  if (n < 1) return { value, derivative };

  let tPrev = 1;
  let tCurr = s;
  value += coeffs[1] * tCurr;

  let uPrev = 0; // U_{-1}
  let uCurr = 1; // U_0
  derivative += coeffs[1] * uCurr; // d/ds T_1 = 1 * U_0

  for (let k = 2; k <= n; k++) {
    const tNext = 2 * s * tCurr - tPrev;
    value += coeffs[k] * tNext;
    tPrev = tCurr;
    tCurr = tNext;

    const uNext = 2 * s * uCurr - uPrev;
    derivative += coeffs[k] * k * uNext;
    uPrev = uCurr;
    uCurr = uNext;
  }
  return { value, derivative };
}
