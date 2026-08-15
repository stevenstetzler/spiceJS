// A globally-linear trajectory sampled at equal time steps (SPK types
// 8/12) -- exactly reconstructed by Lagrange/Hermite interpolation
// regardless of which states end up in the window (same reasoning as
// test/spk.test.js's own equalStepSegment()), so the analytic answer
// is hand-computable independent of which byte range actually got fetched.
export function equalStepLinearSegment({ target, center, frame = 1, p0, v0, n = 12, step = 40, begin = -240, degree = 3 }) {
  const ets = Array.from({ length: n }, (_, i) => begin + i * step);
  const states = ets.map((t) => [...p0.map((p, ax) => p + v0[ax] * t), ...v0]);
  return {
    target,
    center,
    frame,
    type: 8, // Lagrange -- the byte-range math is identical for 12 (Hermite), tested separately with `type: 12`
    startEt: ets[0],
    stopEt: ets[ets.length - 1],
    begin,
    step,
    degree,
    states,
    n,
    expectedStateAt: (et) => ({ position: p0.map((p, ax) => p + v0[ax] * et), velocity: v0 }),
  };
}
