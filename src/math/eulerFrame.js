/**
 * Body orientation matrices, built from a sequence of elementary
 * (passive/coordinate-system) axis rotations -- the same `[angle]_axis`
 * notation and left-to-right composition NAIF uses throughout (ROTATE,
 * EUL2M; see scripts/extract-inertial-frames.mjs, which uses this same
 * convention for the 21 built-in inertial frames):
 *
 *   compose([{axis: a1, theta: t1}, {axis: a2, theta: t2}, ...])
 *     = [t1]_a1 [t2]_a2 ...   (a matrix product, t1's factor leftmost)
 *
 * Used for:
 *  - TIPM = [W]_3 [DELTA]_1 [PHI]_3, the inertial (J2000) -> body-fixed
 *    orientation matrix (NAIF's tisbod.c), from either a binary PCK's
 *    Euler angles or the classic RA/DEC/W polynomial formula
 *    (bodyOrientation.js) -- and DTIPM, its time derivative, via the
 *    product rule over the same 3 factors.
 *  - TK (fixed-offset) frames' constant `ANGLES`/`AXES` rotation
 *    (NAIF's tkfram.c calling EUL2M), which needs no derivative.
 */

function identity3() {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

function multiply3(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

function add3(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i][j] = a[i][j] + b[i][j];
  }
  return out;
}

/** Elementary passive (coordinate-system) rotation by `theta` radians about axis 1, 2, or 3 -- NAIF's ROTATE. */
export function axisRotation(axis, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  if (axis === 1) {
    return [
      [1, 0, 0],
      [0, c, s],
      [0, -s, c],
    ];
  }
  if (axis === 2) {
    return [
      [c, 0, -s],
      [0, 1, 0],
      [s, 0, c],
    ];
  }
  if (axis === 3) {
    return [
      [c, s, 0],
      [-s, c, 0],
      [0, 0, 1],
    ];
  }
  throw new Error(`eulerFrame: invalid axis ${axis} (expected 1, 2, or 3)`);
}

/** d/dtheta of axisRotation(axis, theta). */
function axisRotationDerivative(axis, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  if (axis === 1) {
    return [
      [0, 0, 0],
      [0, -s, c],
      [0, -c, -s],
    ];
  }
  if (axis === 2) {
    return [
      [-s, 0, -c],
      [0, 0, 0],
      [c, 0, -s],
    ];
  }
  if (axis === 3) {
    return [
      [-s, c, 0],
      [-c, -s, 0],
      [0, 0, 0],
    ];
  }
  throw new Error(`eulerFrame: invalid axis ${axis} (expected 1, 2, or 3)`);
}

/**
 * `[pairs[0].theta]_{pairs[0].axis} [pairs[1].theta]_{pairs[1].axis} ...`
 * -- a left-to-right matrix product, `pairs[0]`'s factor leftmost.
 *
 * @param {Array<{axis: number, theta: number}>} pairs
 * @returns {number[][]} 3x3
 */
export function composeAxisRotations(pairs) {
  let m = identity3();
  for (const { axis, theta } of pairs) {
    m = multiply3(m, axisRotation(axis, theta));
  }
  return m;
}

/**
 * Like composeAxisRotations(), but each pair also carries `rate` =
 * d(theta)/dt, and this additionally returns the composed product's
 * time derivative via the product rule:
 *   d/dt (A1 A2 ... An) = sum_i A1 ... A_{i-1} (rate_i * dA_i/dtheta) A_{i+1} ... An
 *
 * @param {Array<{axis: number, theta: number, rate: number}>} pairs
 * @returns {{ matrix: number[][], dmatrix: number[][] }}
 */
export function composeAxisRotationsWithDerivative(pairs) {
  const factors = pairs.map(({ axis, theta }) => axisRotation(axis, theta));
  const derivativeFactors = pairs.map(({ axis, theta, rate }) => {
    const d = axisRotationDerivative(axis, theta);
    return d.map((row) => row.map((x) => x * rate));
  });

  // Prefix[i] = factors[0]*...*factors[i-1] (identity for i=0);
  // suffix[i] = factors[i+1]*...*factors[n-1] (identity for i=n-1).
  const n = factors.length;
  const prefix = [identity3()];
  for (let i = 0; i < n; i++) prefix.push(multiply3(prefix[i], factors[i]));
  const suffix = [identity3()];
  for (let i = n - 1; i >= 0; i--) suffix.unshift(multiply3(factors[i], suffix[0]));

  let dmatrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const term = multiply3(multiply3(prefix[i], derivativeFactors[i]), suffix[i + 1]);
    dmatrix = add3(dmatrix, term);
  }

  return { matrix: prefix[n], dmatrix };
}

/**
 * TIPM (inertial J2000 -> body-fixed) and its time derivative DTIPM,
 * from a body's Euler angles PHI/DELTA/W and their rates (radians,
 * rad/s) -- NAIF's tisbod.c: `TIPM = [W]_3 [DELTA]_1 [PHI]_3`.
 *
 * @returns {{ tipm: number[][], dtipm: number[][] }}
 */
export function tipmFromEulerAngles(phi, delta, w, dphi, ddelta, dw) {
  const { matrix, dmatrix } = composeAxisRotationsWithDerivative([
    { axis: 3, theta: w, rate: dw },
    { axis: 1, theta: delta, rate: ddelta },
    { axis: 3, theta: phi, rate: dphi },
  ]);
  return { tipm: matrix, dtipm: dmatrix };
}

/** 3x3 transpose. */
export function transpose3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export { multiply3, identity3 };
