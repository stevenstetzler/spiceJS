// Runs every case in cases.json through spiceJS and writes
// results-js.json, in the same shape run-py.py writes results-py.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { furnsh, str2et, spkez, spkezr, spkState, bodyValues, prop2b, scEncode, scDecode, sclkToEt, etToSclk, ckgp, ckgpav, etToTai, taiToEt } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

furnsh(path.join(here, '../kernels/naif0012.tls'));
furnsh(path.join(here, 'pck00010.tpc'));
furnsh(path.join(here, 'pck00011.tpc'));
furnsh(path.join(here, 'gm_de440.tpc'));
furnsh(path.join(here, 'dss17.bsp'));
furnsh(path.join(fixturesDir, 'kernel.bsp'));
furnsh(path.join(fixturesDir, 'sclk.tsc'));
furnsh(path.join(fixturesDir, 'ck.bc'));

const {
  str2etCases,
  taiCases,
  spkezCases,
  spkezrCases,
  spkStateCases,
  bodyValueCases,
  prop2bCases,
  sc,
  scEncodeCases,
  scDecodeCases,
  sclkToEtCases,
  etToSclkCases,
  ckCases,
} = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'cases.json'), 'utf8'));

const str2etResults = str2etCases.map((timeString) => {
  try {
    return { input: timeString, et: str2et(timeString) };
  } catch (err) {
    return { input: timeString, error: err.message };
  }
});

const taiResults = (taiCases || []).map((et) => {
  const tai = etToTai(et);
  return { input: et, tai, roundTripEt: taiToEt(tai) };
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

const prop2bResults = (prop2bCases || []).map((c) => {
  try {
    return { input: c, state: prop2b(c.gm, c.pvinit, c.dt) };
  } catch (err) {
    return { input: c, error: err.message };
  }
});

const scEncodeResults = (scEncodeCases || []).map((clockString) => {
  try {
    return { input: clockString, ticks: scEncode(sc, clockString) };
  } catch (err) {
    return { input: clockString, error: err.message };
  }
});

const scDecodeResults = (scDecodeCases || []).map((ticks) => {
  try {
    return { input: ticks, clockString: scDecode(sc, ticks) };
  } catch (err) {
    return { input: ticks, error: err.message };
  }
});

const sclkToEtResults = (sclkToEtCases || []).map((ticks) => {
  try {
    return { input: ticks, et: sclkToEt(sc, ticks) };
  } catch (err) {
    return { input: ticks, error: err.message };
  }
});

const etToSclkResults = (etToSclkCases || []).map((et) => {
  try {
    return { input: et, ticks: etToSclk(sc, et) };
  } catch (err) {
    return { input: et, error: err.message };
  }
});

const ckResults = (ckCases || []).map((c) => {
  try {
    const { found, cmat, av, clkout } = c.needAv ? ckgpav(c.inst, c.sclkdp, c.tol, c.ref) : ckgp(c.inst, c.sclkdp, c.tol, c.ref);
    if (!found) return { input: c, found: false };
    return { input: c, found: true, cmat, av: av ?? null, clkout };
  } catch (err) {
    return { input: c, error: err.message };
  }
});

fs.writeFileSync(
  path.join(fixturesDir, 'results-js.json'),
  JSON.stringify(
    {
      str2etResults,
      taiResults,
      spkezResults,
      spkezrResults,
      spkStateResults,
      bodyValueResults,
      prop2bResults,
      scEncodeResults,
      scDecodeResults,
      sclkToEtResults,
      etToSclkResults,
      ckResults,
    },
    null,
    2
  )
);
console.log(
  `spiceJS: ${str2etResults.length} str2et cases, ${taiResults.length} tai cases, ${spkezResults.length} spkez cases, ` +
    `${spkezrResults.length} spkezr cases, ${spkStateResults.length} spkState cases, ` +
    `${bodyValueResults.length} bodyValues cases, ${prop2bResults.length} prop2b cases, ` +
    `${scEncodeResults.length + scDecodeResults.length + sclkToEtResults.length + etToSclkResults.length} sclk cases, ` +
    `${ckResults.length} ck cases -> results-js.json`
);
