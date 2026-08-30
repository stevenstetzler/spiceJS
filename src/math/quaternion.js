/**
 * Quaternion/rotation-matrix conversions needed by CK segment types 2
 * and 3 (ck.js) -- SPICE's Q2M, AXISAR, and RAXISA, ported from
 * `q2m.c`/`axisar.c`/`raxisa.c`/`m2q.c` in the OpenSpace/Spice mirror.
 *
 * Quaternions here are `[q0, q1, q2, q3]`, **scalar-first** -- SPICE's
 * own convention (NAIF's "Rotation" required reading), not the
 * scalar-last `[x,y,z,w]` convention some other libraries use. Matrices
 * are plain `number[][]` (row-major, `m[row][col]`), matching every
 * other rotation matrix in this codebase (`math/eulerFrame.js`,
 * `frames.js`).
 *
 * `q2m_`'s own Fortran array is column-major (`r(i,j)` at flat index
 * `(j-1)*3+(i-1)`) -- re-derived here directly in terms of `m[row][col]`
 * (0-indexed) so the formulas below read as ordinary row/col math, not
 * a transcription of Fortran's flat layout. Cross-checked against
 * spiceypy (`spiceypy.q2m`/`axisar`/`raxisa`) in crossval -- see
 * `crossval/README.md`.
 */
import { rotateAboutAxis, norm } from './vector3.js';

/**
 * Quaternion -> rotation matrix (Q2M). `q` need not be unit length --
 * matches CSPICE's own behavior of rescaling by `1/|q|^2` when
 * `|q|^2` is neither 0 nor 1 (the all-zero quaternion is left
 * unnormalized, same as CSPICE, and produces the identity matrix
 * below since every cross term vanishes).
 *
 * @param {number[]} q - `[q0, q1, q2, q3]`, scalar-first
 * @returns {number[][]} 3x3
 */
export function quaternionToMatrix(q) {
  let [q0, q1, q2, q3] = q;
  const l2 = q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3;
  if (l2 !== 1 && l2 !== 0) {
    const sharpen = 1 / l2;
    q0 *= Math.sqrt(sharpen);
    q1 *= Math.sqrt(sharpen);
    q2 *= Math.sqrt(sharpen);
    q3 *= Math.sqrt(sharpen);
  }
  const q01 = q0 * q1,
    q02 = q0 * q2,
    q03 = q0 * q3;
  const q12 = q1 * q2,
    q13 = q1 * q3,
    q23 = q2 * q3;
  const q1s = q1 * q1,
    q2s = q2 * q2,
    q3s = q3 * q3;
  return [
    [1 - 2 * (q2s + q3s), 2 * (q12 - q03), 2 * (q13 + q02)],
    [2 * (q12 + q03), 1 - 2 * (q1s + q3s), 2 * (q23 - q01)],
    [2 * (q13 - q02), 2 * (q23 + q01), 1 - 2 * (q1s + q2s)],
  ];
}

/**
 * Rotation matrix -> quaternion (M2Q), Shepperd's method (the same
 * branch-selection CSPICE uses for numerical stability -- picking
 * whichever of the four possible expressions has the largest
 * denominator avoids the precision loss any single fixed formula hits
 * near particular rotation angles/axes). Always returns a quaternion
 * with `q0 >= 0` (CSPICE's own sign convention -- a rotation matrix
 * doesn't distinguish `q` from `-q`, so a fixed sign choice is needed
 * for a well-defined inverse of `quaternionToMatrix()`).
 *
 * Does not verify `m` is actually a rotation (orthogonal, det=+1) --
 * every caller in this codebase only ever passes a matrix already
 * built by `quaternionToMatrix()`/`axisAngleToMatrix()`/composition of
 * the two, so an invalid input would be a bug elsewhere, not a
 * real-world "bad kernel data" case to defend against here (unlike
 * CSPICE's own M2Q, exposed as a public entry point).
 *
 * @param {number[][]} m
 * @returns {number[]} `[q0, q1, q2, q3]`
 */
export function matrixToQuaternion(m) {
  const trace = m[0][0] + m[1][1] + m[2][2];
  const mtrace = 1 - trace;
  const cc4 = trace + 1;
  const s114 = mtrace + 2 * m[0][0];
  const s224 = mtrace + 2 * m[1][1];
  const s334 = mtrace + 2 * m[2][2];

  let c, s0, s1, s2;
  if (cc4 >= 1) {
    c = Math.sqrt(cc4 / 4);
    const factor = 1 / (4 * c);
    s0 = (m[2][1] - m[1][2]) * factor;
    s1 = (m[0][2] - m[2][0]) * factor;
    s2 = (m[1][0] - m[0][1]) * factor;
  } else if (s114 >= 1) {
    s0 = Math.sqrt(s114 / 4);
    const factor = 1 / (4 * s0);
    c = (m[2][1] - m[1][2]) * factor;
    s1 = (m[0][1] + m[1][0]) * factor;
    s2 = (m[0][2] + m[2][0]) * factor;
  } else if (s224 >= 1) {
    s1 = Math.sqrt(s224 / 4);
    const factor = 1 / (4 * s1);
    c = (m[0][2] - m[2][0]) * factor;
    s0 = (m[0][1] + m[1][0]) * factor;
    s2 = (m[1][2] + m[2][1]) * factor;
  } else {
    s2 = Math.sqrt(s334 / 4);
    const factor = 1 / (4 * s2);
    c = (m[1][0] - m[0][1]) * factor;
    s0 = (m[0][2] + m[2][0]) * factor;
    s1 = (m[1][2] + m[2][1]) * factor;
  }

  const l2 = c * c + s0 * s0 + s1 * s1 + s2 * s2;
  if (l2 !== 1) {
    const polish = 1 / Math.sqrt(l2);
    c *= polish;
    s0 *= polish;
    s1 *= polish;
    s2 *= polish;
  }
  return c > 0 ? [c, s0, s1, s2] : [-c, -s0, -s1, -s2];
}

/**
 * Axis + angle -> rotation matrix (AXISAR): the standard "rotate a
 * vector forward by `angle` radians about `axis`" matrix (right-hand
 * rule; `axis` need not be unit length) -- i.e. the matrix whose
 * *column* `i` is the standard basis vector `e_i` rotated by `angle`
 * about `axis`, reusing `vector3.js`'s already-tested
 * `rotateAboutAxis()` rather than re-deriving the Rodrigues formula
 * directly. (`axisar_`'s own Fortran loop writes into contiguous
 * 3-element chunks of a flat 9-array -- which, given CSPICE's
 * column-major flat-matrix convention confirmed against real output in
 * `quaternionToMatrix()`'s own doc comment, means those chunks are
 * columns, not rows; verified directly against spiceypy's `axisar` on
 * a known case, not just inferred from the loop shape -- an earlier,
 * row-based version of this function silently passed its own unit
 * test, whose "expected" value was derived with the exact same
 * mistake, but disagreed with real CSPICE the moment crossval actually
 * exercised a case with a nonzero rotation angle.)
 *
 * @param {number[]} axis
 * @param {number} angle - radians
 * @returns {number[][]} 3x3
 */
export function axisAngleToMatrix(axis, angle) {
  const col0 = rotateAboutAxis([1, 0, 0], axis, angle);
  const col1 = rotateAboutAxis([0, 1, 0], axis, angle);
  const col2 = rotateAboutAxis([0, 0, 1], axis, angle);
  return [
    [col0[0], col1[0], col2[0]],
    [col0[1], col1[1], col2[1]],
    [col0[2], col1[2], col2[2]],
  ];
}

/**
 * Rotation matrix -> axis + angle (RAXISA), via `matrixToQuaternion()`
 * -- `{ axis, angle }`, `axis` unit length, `angle` in `[0, pi]`
 * radians. The identity matrix (no rotation) returns `angle: 0` with
 * an arbitrary `axis: [0, 0, 1]` (CSPICE's own convention -- any axis
 * is equally valid for a zero rotation).
 *
 * @param {number[][]} m
 * @returns {{ axis: number[], angle: number }}
 */
export function matrixToAxisAngle(m) {
  const [q0, q1, q2, q3] = matrixToQuaternion(m);
  const v = [q1, q2, q3];
  const vNorm = norm(v);
  if (vNorm === 0) {
    return { axis: [0, 0, 1], angle: 0 };
  }
  if (q0 === 0) {
    // |v| == 1 already here (q0^2 + |v|^2 == 1 for a unit quaternion).
    return { axis: v, angle: Math.PI };
  }
  return { axis: [v[0] / vNorm, v[1] / vNorm, v[2] / vNorm], angle: 2 * Math.atan2(vNorm, q0) };
}
