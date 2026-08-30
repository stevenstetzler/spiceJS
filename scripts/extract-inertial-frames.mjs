// One-time (re-runnable) extractor: parses NAIF's own chgirf.c (the
// 21 built-in inertial reference frames -- J2000, B1950, ECLIPJ2000,
// GALACTIC, ...) straight from source and emits
// src/data/inertialFrames.js. See src/frames.js for how it's used.
//
// Each frame is defined relative to a "base" frame (J2000 is the
// root, defined relative to itself) by a sequence of elementary
// axis-rotations, applied in the *reverse* of the order they're
// listed (confirmed from chgirf.c's own doc comment: `defs =
// "22.34 3 31.21 2 0.449 1"` means `v_new = [22.34]_3 [31.21]_2
// [0.449]_1 v_old`, i.e. rotate by 0.449" about axis 1 first). This
// composes each frame's chain of rotations back to J2000 once, so the
// runtime only needs one fixed 3x3 matrix per frame.
//
// Usage: node scripts/extract-inertial-frames.mjs <path-to-chgirf.c>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('usage: node scripts/extract-inertial-frames.mjs <path-to-chgirf.c>');
  process.exit(1);
}
const source = fs.readFileSync(sourcePath, 'utf8');

/** Extract a `static char NAME[W*N] = "..." "..." ...;` array as N fixed-width strings. */
function extractFixedWidthArray(varName, width, count) {
  const declRe = new RegExp(`static char ${varName}\\[${width}\\s*\\*\\s*${count}\\]\\s*=([\\s\\S]*?);`);
  const declMatch = source.match(declRe);
  if (!declMatch) {
    throw new Error(`extract-inertial-frames: couldn't find "static char ${varName}[${width}*${count}] = ...;"`);
  }
  const fragments = declMatch[1].match(/"([^"\\]|\\.)*"/g) || [];
  const joined = fragments.map((f) => f.slice(1, -1)).join('');
  if (joined.length !== width * count) {
    throw new Error(
      `extract-inertial-frames: ${varName} concatenated to ${joined.length} chars, expected ${width * count}`
    );
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(joined.slice(i * width, (i + 1) * width).trim());
  }
  return out;
}

const N = 21;
const names = extractFixedWidthArray('frames', 16, N);
const bases = extractFixedWidthArray('bases', 16, N);
const rawDefs = extractFixedWidthArray('defs', 80, N);

// Each def is "angle axis angle axis ..." (arcseconds, axis 1|2|3),
// space- or comma-separated.
const defs = rawDefs.map((raw) => {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  if (tokens.length % 2 !== 0) {
    throw new Error(`extract-inertial-frames: odd token count in def "${raw}"`);
  }
  const pairs = [];
  for (let i = 0; i < tokens.length; i += 2) {
    pairs.push({ arcsec: Number(tokens[i].replace(/D0$/i, '')), axis: Number(tokens[i + 1]) });
  }
  return pairs;
});

const ARCSEC_TO_RAD = Math.PI / (180 * 3600);

function identity3() {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

function multiply3(a, b) {
  const out = identity3();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

/** Elementary passive (frame) rotation by `theta` radians about axis 1, 2, or 3. */
function axisRotation(axis, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  if (axis === 1) {
    return [
      [1, 0, 0],
      [0, c, s],
      [0, -s, c],
    ];
  }
  if (axis === 2) {
    return [
      [c, 0, -s],
      [0, 1, 0],
      [s, 0, c],
    ];
  }
  if (axis === 3) {
    return [
      [c, s, 0],
      [-s, c, 0],
      [0, 0, 1],
    ];
  }
  throw new Error(`extract-inertial-frames: invalid axis ${axis}`);
}

// M_base_to_this: compose the def's rotation pairs left-to-right as
// matrix factors (leftmost pair = leftmost/outermost factor), per the
// doc comment's own worked example.
function defToMatrix(pairs) {
  let m = identity3();
  for (const { arcsec, axis } of pairs) {
    m = multiply3(m, axisRotation(axis, arcsec * ARCSEC_TO_RAD));
  }
  return m;
}

const matrixFromJ2000ByIndex = new Array(N);
function resolve(index, seen = new Set()) {
  if (matrixFromJ2000ByIndex[index]) return matrixFromJ2000ByIndex[index];
  if (seen.has(index)) {
    throw new Error(`extract-inertial-frames: circular base chain involving "${names[index]}"`);
  }
  seen.add(index);

  const mBaseToThis = defToMatrix(defs[index]);
  if (names[index] === bases[index]) {
    // Root frame (J2000): defined relative to itself, identity.
    matrixFromJ2000ByIndex[index] = mBaseToThis;
    return mBaseToThis;
  }
  const baseIndex = names.indexOf(bases[index]);
  if (baseIndex === -1) {
    throw new Error(`extract-inertial-frames: base frame "${bases[index]}" of "${names[index]}" not found`);
  }
  const mJ2000ToBase = resolve(baseIndex, seen);
  const mJ2000ToThis = multiply3(mBaseToThis, mJ2000ToBase);
  matrixFromJ2000ByIndex[index] = mJ2000ToThis;
  return mJ2000ToThis;
}

const frames = [];
for (let i = 0; i < N; i++) {
  frames.push({ id: i + 1, name: names[i], matrixFromJ2000: resolve(i) });
}

const out = `/**
 * NAIF's 21 built-in inertial reference frames, extracted directly
 * from NAIF's own source (chgirf.c in the OpenSpace/Spice mirror of
 * CSPICE) by scripts/extract-inertial-frames.mjs -- not hand-
 * transcribed. Do not edit by hand; re-run that script instead.
 *
 * Each frame's chain of base-relative rotations has already been
 * composed into one fixed 3x3 matrix relative to J2000 (these are all
 * genuinely *inertial* -- non-rotating -- frames, so this composition
 * only needs doing once, not per-call). Frame ID = array index + 1,
 * matching the frame IDs already used by SPK segment summaries (e.g.
 * frame 1 = J2000, frame 17 = ECLIPJ2000). See src/frames.js.
 */
export const INERTIAL_FRAMES = ${JSON.stringify(frames, null, 2)};
`;

const outPath = path.join(here, '../src/data/inertialFrames.js');
fs.writeFileSync(outPath, out);
console.log(`Wrote ${frames.length} frames to ${path.relative(process.cwd(), outPath)}`);
