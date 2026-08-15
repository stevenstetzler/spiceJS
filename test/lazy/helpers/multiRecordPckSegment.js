// A globally-linear-in-time Euler-angle trajectory split across many
// fixed-size, fixed-interval type-2 (Chebyshev) records -- mirrors
// multiRecordSegment.js's SPK version exactly, just for PCK's [phi,
// delta, w] instead of [x, y, z].
export function multiRecordLinearPckSegment({ frame, refFrame = 1, a0, da, n = 8, intlen = 100, init = 0 }) {
  const records = [];
  for (let i = 0; i < n; i++) {
    const mid = init + i * intlen + intlen / 2;
    const radius = intlen / 2;
    records.push({ mid, radius, coeffsByAxis: a0.map((a, ax) => [a + da[ax] * mid, da[ax] * radius]) });
  }
  return {
    frame,
    refFrame,
    type: 2,
    startEt: init,
    stopEt: init + n * intlen,
    init,
    intlen,
    records,
    expectedAt: (et) => ({
      eulerAngles: a0.map((a, ax) => a + da[ax] * et),
      eulerRates: da,
    }),
  };
}
