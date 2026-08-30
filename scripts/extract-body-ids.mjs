// One-time (re-runnable) extractor: parses NAIF's own generated
// zzidmap.c (the built-in NAIF ID <-> body name table, ~692 entries)
// straight from source, rather than hand-transcribing it, and emits
// src/data/bodyIds.js. See src/bodies.js for how it's used, and the
// implementation-plan discussion in the commit this file was added in
// for why this table isn't just typed in by hand.
//
// Usage: node scripts/extract-body-ids.mjs <path-to-zzidmap.c>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('usage: node scripts/extract-body-ids.mjs <path-to-zzidmap.c>');
  process.exit(1);
}
const source = fs.readFileSync(sourcePath, 'utf8');

// Each entry looks like (possibly wrapped across lines, with the name
// split across multiple adjacent string-literal fragments, as C does):
//   bltcod[7] = 3;
//   s_copy(bltnam + 252, "EARTH_BARYCENTER", (ftnlen)36, (ftnlen)16);
const ENTRY_RE =
  /bltcod\[(\d+)\]\s*=\s*(-?\d+);\s*s_copy\(bltnam(?:\s*\+\s*\d+)?,\s*((?:"(?:[^"\\]|\\.)*"\s*)+),\s*\(\s*ftnlen\s*\)\s*36\s*,\s*\(\s*ftnlen\s*\)\s*(\d+)\s*\)\s*;/g;

const entries = [];
let match;
while ((match = ENTRY_RE.exec(source)) !== null) {
  const [, index, code, quotedFragments, declaredLen] = match;
  const joined = (quotedFragments.match(/"([^"\\]|\\.)*"/g) || [])
    .map((frag) => frag.slice(1, -1))
    .join('');
  const name = joined.slice(0, Number(declaredLen));
  entries.push({ index: Number(index), code: Number(code), name });
}

// Sanity checks: every index 0..N-1 present exactly once, in order.
entries.sort((a, b) => a.index - b.index);
for (let i = 0; i < entries.length; i++) {
  if (entries[i].index !== i) {
    throw new Error(`extract-body-ids: expected entry index ${i}, got ${entries[i].index} -- parser likely out of sync`);
  }
}
if (entries.length < 600) {
  throw new Error(`extract-body-ids: only found ${entries.length} entries, expected ~692 -- check the regex against the source`);
}

const out = `/**
 * NAIF's built-in body name <-> ID table, extracted directly from
 * NAIF's own generated source (zzidmap.c in the OpenSpace/Spice
 * mirror of CSPICE) by scripts/extract-body-ids.mjs -- not hand-
 * transcribed. Do not edit by hand; re-run that script instead.
 *
 * ${entries.length} entries. Multiple aliases per ID are common (e.g.
 * "MARS_BARYCENTER" and "MARS BARYCENTER" both -> 4); see bodies.js
 * for how names are matched against this table.
 */
export const BODY_IDS = ${JSON.stringify(entries.map(({ code, name }) => [code, name]))};
`;

const outPath = path.join(here, '../src/data/bodyIds.js');
fs.writeFileSync(outPath, out);
console.log(`Wrote ${entries.length} entries to ${path.relative(process.cwd(), outPath)}`);
