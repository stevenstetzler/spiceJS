// A globally-linear trajectory split across many fixed-size,
// fixed-interval type-2 (Chebyshev) records -- exactly representable
// by a degree-1 fit *per record* (see test/spk.test.js's
// linearMotionSegment()), so the analytic answer is hand-computable
// regardless of which record ends up selected. That decouples "is the
// answer right" from "did we fetch the right record range", which is
// exactly what the lazy-loading tests need to check independently.
export function multiRecordLinearSegment({ target, center, frame = 1, p0, v0, n = 8, intlen = 100, init = 0 }) {
  const records = [];
  for (let i = 0; i < n; i++) {
    const mid = init + i * intlen + intlen / 2;
    const radius = intlen / 2;
    records.push({ mid, radius, coeffsByAxis: p0.map((p, ax) => [p + v0[ax] * mid, v0[ax] * radius]) });
  }
  return {
    target,
    center,
    frame,
    type: 2,
    startEt: init,
    stopEt: init + n * intlen,
    init,
    intlen,
    records,
    recordSize: 2 + 3 * 2, // [mid, radius, X0, X1, Y0, Y1, Z0, Z1] -- degree-1 fit, 3 axes
    n,
    expectedStateAt: (et) => ({ position: p0.map((p, ax) => p + v0[ax] * et), velocity: v0 }),
  };
}
