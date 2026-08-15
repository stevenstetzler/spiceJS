// A circular orbit, given directly by its closed form (same
// independent-referee trick test/spk.test.js's own type-5 tests use):
// gm is chosen so this closed form *is* the exact two-body solution,
// so propagating any stored state to any other time on the orbit
// reproduces it exactly -- decoupling "is the answer right" from "did
// we fetch the right byte range".
function circularOrbitState(w, r, t) {
  const c = Math.cos(w * t);
  const s = Math.sin(w * t);
  return [r * c, r * s, 0, -r * w * s, r * w * c, 0];
}

export function circularOrbitSegment({ target, center, epochs }) {
  const r = 7000; // km
  const w = 0.0011; // rad/s
  const gm = w * w * r * r * r;
  const states = epochs.map((t) => circularOrbitState(w, r, t));
  return {
    target,
    center,
    frame: 1,
    type: 5,
    startEt: epochs[0],
    stopEt: epochs[epochs.length - 1],
    gm,
    states,
    epochs,
    n: epochs.length,
    expectedStateAt: (t) => ({
      position: circularOrbitState(w, r, t).slice(0, 3),
      velocity: circularOrbitState(w, r, t).slice(3, 6),
    }),
  };
}
