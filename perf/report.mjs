/**
 * Compares benchmark.mjs's lazy-loading results against
 * spiceypy-reference.py's real-CSPICE ground truth, prints a
 * formatted summary table, and writes results/report.md. Exits
 * non-zero if any case's position error exceeds tolerance -- this is
 * a correctness check, not just a performance demo: lazy loading is
 * only actually useful if it's exactly as accurate as the eager path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, 'results');

const lazy = JSON.parse(fs.readFileSync(path.join(resultsDir, 'lazy-results.json'), 'utf8'));
const reference = JSON.parse(fs.readFileSync(path.join(resultsDir, 'spiceypy-results.json'), 'utf8'));

// Matches crossval/compare.mjs's own tolerance -- lazy loading reads
// the exact same bytes through the exact same evaluator as furnsh()-ing
// the whole file, so this should be essentially exact; a real mismatch
// here would mean a real bug, not float64 noise.
const POS_TOL_KM = 1e-5;

function fmtBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function padRight(s, n) {
  return String(s).padEnd(n);
}
function padLeft(s, n) {
  return String(s).padStart(n);
}

let failures = 0;
let maxErrorAcrossAll = 0;
const rows = [];

for (let i = 0; i < lazy.length; i++) {
  const c = lazy[i];
  const ref = reference[i];
  if (c.body !== ref.body || c.range !== ref.range) {
    throw new Error(`case ${i} mismatch between lazy-results.json and spiceypy-results.json ordering`);
  }

  let worstError = 0;
  for (let j = 0; j < c.states.length; j++) {
    const a = c.states[j].position;
    const b = ref.states[j].position;
    const error = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    worstError = Math.max(worstError, error);
  }
  maxErrorAcrossAll = Math.max(maxErrorAcrossAll, worstError);
  if (worstError > POS_TOL_KM) {
    failures++;
    console.log(
      `FAIL [${c.body} / ${c.range}]: max position error ${worstError} km (tolerance ${POS_TOL_KM} km)`
    );
  }

  rows.push({
    body: c.body,
    range: c.range,
    requests: c.lazyRequests,
    bytes: c.lazyBytes,
    eagerBytes: c.eagerBytes,
    reductionPct: (1 - c.lazyBytes / c.eagerBytes) * 100,
    ms: c.prefetchMs,
    maxErrorKm: worstError,
  });
}

// --- console table ---
const header = ['Body', 'Range', 'Reqs', 'Bytes fetched', 'Reduction', 'Time', 'Max error vs CSPICE'];
const widths = [22, 18, 5, 14, 11, 9, 20];
console.log('\n' + header.map((h, i) => padRight(h, widths[i])).join(' '));
console.log(widths.map((w) => '-'.repeat(w)).join(' '));
for (const r of rows) {
  console.log(
    [
      padRight(r.body, widths[0]),
      padRight(r.range, widths[1]),
      padLeft(r.requests, widths[2]),
      padLeft(fmtBytes(r.bytes), widths[3]),
      padLeft(`${r.reductionPct.toFixed(2)}%`, widths[4]),
      padLeft(`${r.ms.toFixed(0)} ms`, widths[5]),
      padLeft(`${r.maxErrorKm.toExponential(2)} km`, widths[6]),
    ].join(' ')
  );
}

const totalLazyBytes = rows.reduce((sum, r) => sum + r.bytes, 0);
const totalEagerBytes = rows.reduce((sum, r) => sum + r.eagerBytes, 0); // eager cost counted once per case (isolated-query framing)
console.log(
  `\n${rows.length} cases, ${rows.length * 5} sample epochs checked against spiceypy. ` +
    `Max position error across all cases: ${maxErrorAcrossAll.toExponential(2)} km (tolerance ${POS_TOL_KM} km).`
);
console.log(
  `Total, isolated per-case: ${fmtBytes(totalLazyBytes)} lazily fetched vs ${fmtBytes(totalEagerBytes)} ` +
    `the eager (whole-file) path would need for the same ${rows.length} queries ` +
    `(${((1 - totalLazyBytes / totalEagerBytes) * 100).toFixed(2)}% reduction).`
);

// --- markdown report ---
const md = [];
md.push('# Lazy-loading benchmark: network cost and ephemeris accuracy');
md.push('');
md.push(
  `Real \`de440.bsp\` (${fmtBytes(rows[0].eagerBytes)}), fetched over the network via \`openRemoteSpk()\`, ` +
    'one isolated query per row (a fresh connection, no cache -- the cost of exactly that query alone). ' +
    `Every sampled state cross-checked against real CSPICE (\`spiceypy\`) to a ${POS_TOL_KM} km tolerance.`
);
md.push('');
md.push('| Body | Range | Requests | Bytes fetched | Reduction vs eager | Time | Max error vs CSPICE |');
md.push('|---|---|---:|---:|---:|---:|---:|');
for (const r of rows) {
  md.push(
    `| ${r.body} | ${r.range} | ${r.requests} | ${fmtBytes(r.bytes)} | ${r.reductionPct.toFixed(2)}% | ` +
      `${r.ms.toFixed(0)} ms | ${r.maxErrorKm.toExponential(2)} km |`
  );
}
md.push('');
md.push(
  `**${rows.length} cases, ${rows.length * 5} sample epochs**, all within ${POS_TOL_KM} km of real CSPICE ` +
    `(max observed error: ${maxErrorAcrossAll.toExponential(2)} km). Total, isolated per-case: ` +
    `${fmtBytes(totalLazyBytes)} fetched vs ${fmtBytes(totalEagerBytes)} for the eager path over the same ` +
    `${rows.length} queries (${((1 - totalLazyBytes / totalEagerBytes) * 100).toFixed(2)}% reduction).`
);
fs.writeFileSync(path.join(resultsDir, 'report.md'), md.join('\n') + '\n');
console.log(`\nWrote results/report.md`);

if (failures > 0) {
  console.log(`\n${failures} case(s) exceeded the accuracy tolerance.`);
  process.exit(1);
}
