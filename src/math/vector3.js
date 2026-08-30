/**
 * Small 3-vector helpers, used by SPK segment chaining and aberration
 * correction (spk.js). Vectors are plain 3-element arrays.
 */

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm(a) {
  return Math.sqrt(dot(a, a));
}

/** Unit vector in the direction of `a`. Undefined (NaN) for the zero vector. */
export function unit(a) {
  return scale(a, 1 / norm(a));
}

/**
 * Rotate vector `v` by `theta` radians about `axis` (right-hand rule;
 * `axis` need not be unit length). Returns `v` unchanged if `axis` is
 * the zero vector. Standard Rodrigues' rotation formula:
 *   r = v*cos(theta) + (axis_hat x v)*sin(theta) + axis_hat*(axis_hat.v)*(1-cos(theta))
 */
export function rotateAboutAxis(v, axis, theta) {
  const axisNorm = norm(axis);
  if (axisNorm === 0) return v.slice();
  const axisHat = scale(axis, 1 / axisNorm);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const k = dot(axisHat, v);
  return add(add(scale(v, cosT), scale(cross(axisHat, v), sinT)), scale(axisHat, k * (1 - cosT)));
}
