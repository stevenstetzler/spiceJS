// Runs every case in cases.json through spiceJS and writes
// results-js.json, in the same shape run-py.py writes results-py.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { furnsh, str2et, spkez, spkezr, spkState, bodyValues } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

furnsh(path.join(here, '../kernels/naif0012.tls'));
furnsh(path.join(here, 'pck00010.tpc'));
furnsh(path.join(here, 'pck00011.tpc'));
furnsh(path.join(here, 'gm_de440.tpc'));
furnsh(path.join(here, 'dss17.bsp'));
furnsh(path.join(fixturesDir, 'kernel.bsp'));

const { str2etCases, spkezCases, spkezrCases, spkStateCases, bodyValueCases } = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, 'cases.json'), 'utf8')
);

const str2etResults = str2etCases.map((timeString) => {
  try {
    return { input: timeString, et: str2et(timeString) };
  } catch (err) {
    return { input: timeString, error: err.message };
  }
});

const spkezResults = spkezCases.map((c) => {
  try {
    const { position, velocity, lightTime } = spkez(c.target, c.center, c.et, c.abcorr, c.ref ?? null);
    return { input: c, state: [...position, ...velocity], lightTime };
  } catch (err) {
    return { input: c, error: err.message };
  }
});

const spkezrResults = (spkezrCases || []).map((c) => {
  try {
    const { position, velocity, lightTime } = spkezr(c.target, c.observer, c.et, c.abcorr, c.ref ?? null);
    return { input: c, state: [...position, ...velocity], lightTime };
  } catch (err) {
    return { input: c, error: err.message };
  }
});

const spkStateResults = (spkStateCases || []).map((c) => {
  try {
    const { position, velocity } = spkState(c.target, c.center, c.et);
    return { input: c, state: [...position, ...velocity] };
  } catch (err) {
    return { input: c, error: err.message };
  }
});

const bodyValueResults = (bodyValueCases || []).map((c) => {
  try {
    return { input: c, values: bodyValues(c.body, c.item) };
  } catch (err) {
    return { input: c, error: err.message };
  }
});

fs.writeFileSync(
  path.join(fixturesDir, 'results-js.json'),
  JSON.stringify({ str2etResults, spkezResults, spkezrResults, spkStateResults, bodyValueResults }, null, 2)
);
console.log(
  `spiceJS: ${str2etResults.length} str2et cases, ${spkezResults.length} spkez cases, ` +
    `${spkezrResults.length} spkezr cases, ${spkStateResults.length} spkState cases, ` +
    `${bodyValueResults.length} bodyValues cases -> results-js.json`
);
