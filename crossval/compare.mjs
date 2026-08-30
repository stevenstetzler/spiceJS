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

for (let i = 0; i < (js.taiResults || []).length; i++) {
  const a = js.taiResults[i];
  const b = py.taiResults[i];
  if (!closeEnough(a.tai, b.tai, 1e-6, 1e-12)) {
    report('etToTai', a.input, `spiceJS ${a.tai} vs spiceypy ${b.tai} (diff ${Math.abs(a.tai - b.tai)})`);
  } else {
    passed++;
  }
  if (!closeEnough(a.roundTripEt, b.roundTripEt, 1e-6, 1e-12)) {
    report('taiToEt (round trip)', a.input, `spiceJS ${a.roundTripEt} vs spiceypy ${b.roundTripEt} ` +
      `(diff ${Math.abs(a.roundTripEt - b.roundTripEt)})`);
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
    // spkState() (and thus spkgeo, its spiceypy comparison point) has
    // no lightTime -- only compare it when both sides actually report one.
    if ('lightTime' in a && 'lightTime' in b && !closeEnough(a.lightTime, b.lightTime, 1e-9, 1e-9)) {
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

function compareBodyValueResults(label, jsResults, pyResults) {
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
    if (a.values.length !== b.values.length) {
      report(label, a.input, `length mismatch: spiceJS ${a.values.length} vs spiceypy ${b.values.length}`);
      continue;
    }
    const mismatches = [];
    for (let k = 0; k < a.values.length; k++) {
      if (!closeEnough(a.values[k], b.values[k], 1e-9, 1e-9)) {
        mismatches.push(`[${k}]: spiceJS ${a.values[k]} vs spiceypy ${b.values[k]}`);
      }
    }
    if (mismatches.length) {
      report(label, a.input, mismatches.join('; '));
    } else {
      passed++;
    }
  }
}

compareStateResults('spkez', js.spkezResults, py.spkezResults);
compareStateResults('spkezr', js.spkezrResults || [], py.spkezrResults || []);
compareStateResults('spkState', js.spkStateResults || [], py.spkStateResults || []);
compareBodyValueResults('bodyValues', js.bodyValueResults || [], py.bodyValueResults || []);
compareStateResults('prop2b', js.prop2bResults || [], py.prop2bResults || []);

function compareNumericResults(label, jsResults, pyResults, field, absTol = 1e-6, relTol = 1e-9) {
  for (let i = 0; i < jsResults.length; i++) {
    const a = jsResults[i];
    const b = pyResults[i];
    if (a.error || b.error) {
      if (Boolean(a.error) !== Boolean(b.error)) {
        report(label, a.input, `spiceJS ${a.error ? `errored: ${a.error}` : `got ${a[field]}`}, ` +
          `spiceypy ${b.error ? `errored: ${b.error}` : `got ${b[field]}`}`);
      } else {
        passed++;
      }
      continue;
    }
    if (!closeEnough(a[field], b[field], absTol, relTol)) {
      report(label, a.input, `spiceJS ${a[field]} vs spiceypy ${b[field]} (diff ${Math.abs(a[field] - b[field])})`);
    } else {
      passed++;
    }
  }
}

function compareScDecodeResults(jsResults, pyResults) {
  for (let i = 0; i < jsResults.length; i++) {
    const a = jsResults[i];
    const b = pyResults[i];
    if (a.error || b.error) {
      if (Boolean(a.error) !== Boolean(b.error)) {
        report('scDecode', a.input, `spiceJS ${a.error ? `errored: ${a.error}` : `got "${a.clockString}"`}, ` +
          `spiceypy ${b.error ? `errored: ${b.error}` : `got "${b.clockString}"`}`);
      } else {
        passed++;
      }
      continue;
    }
    if (a.clockString !== b.clockString) {
      report('scDecode', a.input, `spiceJS "${a.clockString}" vs spiceypy "${b.clockString}"`);
    } else {
      passed++;
    }
  }
}

compareNumericResults('scEncode', js.scEncodeResults || [], py.scEncodeResults || [], 'ticks', 1e-6, 1e-12);
compareScDecodeResults(js.scDecodeResults || [], py.scDecodeResults || []);
compareNumericResults('sclkToEt', js.sclkToEtResults || [], py.sclkToEtResults || [], 'et');
compareNumericResults('etToSclk', js.etToSclkResults || [], py.etToSclkResults || [], 'ticks', 1e-6, 1e-9);

function compareCkResults(jsResults, pyResults) {
  for (let i = 0; i < jsResults.length; i++) {
    const a = jsResults[i];
    const b = pyResults[i];
    // spiceJS reports a miss as `found: false`; spiceypy's ckgp/ckgpav
    // raise instead (see run-py.py's own comment) -- both mean "no
    // pointing satisfies this request," so they're equivalent outcomes
    // here, not a mismatch.
    const aMissing = a.found === false || Boolean(a.error);
    const bMissing = Boolean(b.error);
    if (aMissing || bMissing) {
      if (aMissing !== bMissing) {
        report('ck', a.input, `spiceJS ${aMissing ? 'found nothing' : 'found a result'}, ` +
          `spiceypy ${bMissing ? `errored: ${b.error}` : 'found a result'}`);
      } else {
        passed++;
      }
      continue;
    }
    const mismatches = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (!closeEnough(a.cmat[r][c], b.cmat[r][c], 1e-9, 1e-9)) {
          mismatches.push(`cmat[${r}][${c}]: spiceJS ${a.cmat[r][c]} vs spiceypy ${b.cmat[r][c]}`);
        }
      }
    }
    if (a.av && b.av) {
      for (let k = 0; k < 3; k++) {
        if (!closeEnough(a.av[k], b.av[k], 1e-9, 1e-9)) {
          mismatches.push(`av[${k}]: spiceJS ${a.av[k]} vs spiceypy ${b.av[k]}`);
        }
      }
    } else if (Boolean(a.av) !== Boolean(b.av)) {
      mismatches.push(`av presence: spiceJS ${a.av ? 'present' : 'absent'}, spiceypy ${b.av ? 'present' : 'absent'}`);
    }
    if (!closeEnough(a.clkout, b.clkout, 1e-6, 1e-9)) {
      mismatches.push(`clkout: spiceJS ${a.clkout} vs spiceypy ${b.clkout}`);
    }
    if (mismatches.length) {
      report('ck', a.input, mismatches.join('; '));
    } else {
      passed++;
    }
  }
}

compareCkResults(js.ckResults || [], py.ckResults || []);

console.log(`\n${passed} passed, ${failures} failed (of ${passed + failures} cases).`);
if (failures > 0) {
  process.exit(1);
}
