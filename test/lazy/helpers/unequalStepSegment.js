// A globally-linear trajectory sampled at deliberately non-uniform
// epochs (SPK types 9/13) -- exactly reconstructed by Lagrange/
// Hermite interpolation regardless of which states end up in the
// window (same reasoning as equalStepSegment.js), so the analytic
// answer is hand-computable independent of which byte range actually
// got fetched.
export function unequalStepLinearSegment({ target, center, frame = 1, p0, v0, epochs, degree = 3 }) {
  const states = epochs.map((t) => [...p0.map((p, ax) => p + v0[ax] * t), ...v0]);
  return {
    target,
    center,
    frame,
    type: 9, // Lagrange -- the byte-range math is identical for 13 (Hermite), tested separately with `type: 13`
    startEt: epochs[0],
    stopEt: epochs[epochs.length - 1],
    degree,
    states,
    epochs,
    n: epochs.length,
    expectedStateAt: (et) => ({ position: p0.map((p, ax) => p + v0[ax] * et), velocity: v0 }),
  };
}
