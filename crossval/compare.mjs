// Diffs results-js.json against results-py.json, case by case, and
// reports every mismatch beyond tolerance. Exits non-zero on any
// mismatch (including one side erroring and the other not).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const js = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'results-js.json'), 'utf8'));
const py = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'results-py.json'), 'utf8'));

function closeEnough(a, b, absTol, relTol, scale = Math.max(Math.abs(a), Math.abs(b))) {
  const diff = Math.abs(a - b);
  return diff <= absTol || diff <= relTol * scale;
}

function vectorNorm(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function describe(input) {
  return typeof input === 'string' ? `"${input}"` : JSON.stringify(input);
}

let failures = 0;
let passed = 0;

function report(label, input, message) {
  failures++;
  console.log(`FAIL [${label}] ${describe(input)}: ${message}`);
}

for (let i = 0; i < js.str2etResults.length; i++) {
  const a = js.str2etResults[i];
  const b = py.str2etResults[i];
  if (a.error || b.error) {
    if (Boolean(a.error) !== Boolean(b.error)) {
      report('str2et', a.input, `spiceJS ${a.error ? `errored: ${a.error}` : `got ${a.et}`}, ` +
        `spiceypy ${b.error ? `errored: ${b.error}` : `got ${b.et}`}`);
    } else {
      passed++; // both errored -- not comparing error message text
    }
    continue;
  }
  if (!closeEnough(a.et, b.et, 1e-6, 1e-12)) {
    report('str2et', a.input, `spiceJS ${a.et} vs spiceypy ${b.et} (diff ${Math.abs(a.et - b.et)})`);
  } else {
    passed++;
  }
}

function compareStateResults(label, jsResults, pyResults) {
  for (let i = 0; i < jsResults.length; i++) {
    const a = jsResults[i];
    const b = pyResults[i];
    if (a.error || b.error) {
      if (Boolean(a.error) !== Boolean(b.error)) {
        report(label, a.input, `spiceJS ${a.error ? `errored: ${a.error}` : 'succeeded'}, ` +
          `spiceypy ${b.error ? `errored: ${b.error}` : 'succeeded'}`);
      } else {
        passed++;
      }
      continue;
    }
    const labels = ['x', 'y', 'z', 'vx', 'vy', 'vz'];
    let ok = true;
    const mismatches = [];
    // Relative tolerance is against the *vector's own norm*, not each
    // component's individual magnitude: rotating a large vector (e.g.
    // ~1e9 km, common for planetary positions) into a frame where one
    // output component happens to be near zero is catastrophic
    // cancellation, not imprecision -- float64 rounding in the
    // rotation is proportional to the input's magnitude, so comparing
    // a coincidentally-small *output* component against its own tiny
    // magnitude would flag entirely expected rounding noise as a
    // mismatch.
    const posScale = Math.max(vectorNorm(a.state.slice(0, 3)), vectorNorm(b.state.slice(0, 3)));
    const velScale = Math.max(vectorNorm(a.state.slice(3, 6)), vectorNorm(b.state.slice(3, 6)));
    for (let k = 0; k < 6; k++) {
      // Velocity gets a slightly looser tolerance for non-inertial
      // `ref` frames: spiceJS deliberately gets aberration-corrected
      // velocity by central-differencing position (see spk.js's own
      // comment on VELOCITY_DERIVATIVE_STEP_S) rather than hand-
      // deriving every analytic correction term NAIF's C code does,
      // and for a fast-rotating body-fixed frame applied to a large
      // lever arm (e.g. the Earth-Moon distance rotated by IAU_EARTH's
      // ~360 deg/day spin), that finite-difference noise floor is
      // itself around 1e-5 km/s (0.01 cm/s) -- utterly negligible
      // physically, but occasionally just outside a 1e-5/1e-9 bound.
      const [absTol, relTol] = k < 3 ? [1e-5, 1e-9] : [5e-5, 5e-9];
      const scale = k < 3 ? posScale : velScale;
      if (!closeEnough(a.state[k], b.state[k], absTol, relTol, scale)) {
        ok = false;
        mismatches.push(`${labels[k]}: spiceJS ${a.state[k]} vs spiceypy ${b.state[k]}`);
      }
    }
    if (!closeEnough(a.lightTime, b.lightTime, 1e-9, 1e-9)) {
      ok = false;
      mismatches.push(`lightTime: spiceJS ${a.lightTime} vs spiceypy ${b.lightTime}`);
    }
    if (!ok) {
      report(label, a.input, mismatches.join('; '));
    } else {
      passed++;
    }
  }
}

compareStateResults('spkez', js.spkezResults, py.spkezResults);
compareStateResults('spkezr', js.spkezrResults || [], py.spkezrResults || []);

console.log(`\n${passed} passed, ${failures} failed (of ${passed + failures} cases).`);
if (failures > 0) {
  process.exit(1);
}
