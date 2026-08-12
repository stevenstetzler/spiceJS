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

function closeEnough(a, b, absTol, relTol) {
  const diff = Math.abs(a - b);
  return diff <= absTol || diff <= relTol * Math.max(Math.abs(a), Math.abs(b));
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

for (let i = 0; i < js.spkezResults.length; i++) {
  const a = js.spkezResults[i];
  const b = py.spkezResults[i];
  if (a.error || b.error) {
    if (Boolean(a.error) !== Boolean(b.error)) {
      report('spkez', a.input, `spiceJS ${a.error ? `errored: ${a.error}` : 'succeeded'}, ` +
        `spiceypy ${b.error ? `errored: ${b.error}` : 'succeeded'}`);
    } else {
      passed++;
    }
    continue;
  }
  const labels = ['x', 'y', 'z', 'vx', 'vy', 'vz'];
  let ok = true;
  const mismatches = [];
  for (let k = 0; k < 6; k++) {
    if (!closeEnough(a.state[k], b.state[k], 1e-5, 1e-9)) {
      ok = false;
      mismatches.push(`${labels[k]}: spiceJS ${a.state[k]} vs spiceypy ${b.state[k]}`);
    }
  }
  if (!closeEnough(a.lightTime, b.lightTime, 1e-9, 1e-9)) {
    ok = false;
    mismatches.push(`lightTime: spiceJS ${a.lightTime} vs spiceypy ${b.lightTime}`);
  }
  if (!ok) {
    report('spkez', a.input, mismatches.join('; '));
  } else {
    passed++;
  }
}

console.log(`\n${passed} passed, ${failures} failed (of ${passed + failures} cases).`);
if (failures > 0) {
  process.exit(1);
}
