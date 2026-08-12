// One-time (re-runnable) extractor: parses NAIF's own zzfdat.c (the
// built-in frame table backing BLTFRM/CIDFRM/NAMFRM) straight from
// source and emits src/data/bodyFixedFrames.js -- the ~123 built-in
// *body-fixed* (class 2 / PCK) reference frames (IAU_MOON, IAU_EARTH,
// IAU_MARS, ...). The 21 built-in *inertial* (class 1) frames are
// extracted separately by extract-inertial-frames.mjs.
//
// zzfdat.c assigns these sequentially, one frame per few lines:
//
//   s_copy(name__ + <index-expr>, "NAME", ...);
//   idcode[<index-expr>] = <id>;
//   center[<index-expr>] = <center>;
//   typid[<index-expr>]  = <classId>;
//   type__[<index-expr>] = <type>;   // 1 = inertial, 2 = PCK, 4 = TK
//
// The index expressions aren't uniform (some are `name_len * N`,
// others `name_len << k` for powers of two) so this parses by
// *sequential order of occurrence* in the non-inertial section, not
// by evaluating the index arithmetic. Only `type__ == 2` rows are
// kept -- the sole `type__ == 4` row (EARTH_FIXED) is a hardcoded
// ITRF93-relative TK frame, not PCK-driven, and out of scope.
//
// Usage: node scripts/extract-body-fixed-frames.mjs <path-to-zzfdat.c>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('usage: node scripts/extract-body-fixed-frames.mjs <path-to-zzfdat.c>');
  process.exit(1);
}
const source = fs.readFileSync(sourcePath, 'utf8');

// Only look at the non-inertial section (after the 21-frame inertial
// for-loop, which has no per-frame s_copy/idcode/type__ assignments to
// confuse the parser) through the end of the assignments (the
// "template for adding another frame" comment block marks the end).
const sectionStart = source.indexOf('Non-Inertial Frames Section');
const sectionEnd = source.indexOf('template to use for adding another non-inertial');
if (sectionStart === -1 || sectionEnd === -1) {
  throw new Error('extract-body-fixed-frames: could not locate the non-inertial assignment section');
}
const section = source.slice(sectionStart, sectionEnd);

// One combined regex, applied repeatedly: a name, then (in order,
// possibly with other frames' idcode/center/typid/type__ lines
// between -- there aren't, but don't assume tight adjacency) the four
// scalar assignments up to the next s_copy or the section end.
const FRAME_RE =
  /s_copy\(name__ \+ [^,]+, "([^"]+)"[\s\S]*?idcode\[[^\]]+\] = (-?\d+);[\s\S]*?center\[[^\]]+\] = (-?\d+);[\s\S]*?typid\[[^\]]+\] = (-?\d+);[\s\S]*?type__\[[^\]]+\] = (\d+);/g;

const frames = [];
let match;
let count = 0;
while ((match = FRAME_RE.exec(section)) !== null) {
  count++;
  const [, name, idcode, , typid, type] = match;
  if (Number(type) !== 2) continue; // skip the one TK row (EARTH_FIXED)
  frames.push({ id: Number(idcode), name, classId: Number(typid) });
}

if (count !== 124) {
  throw new Error(`extract-body-fixed-frames: found ${count} non-inertial frame rows, expected 124`);
}
if (frames.length !== 123) {
  throw new Error(`extract-body-fixed-frames: kept ${frames.length} type__==2 rows, expected 123`);
}

const out = `/**
 * NAIF's built-in *body-fixed* (class 2 / PCK) reference frames --
 * IAU_MOON, IAU_EARTH, IAU_MARS, ... -- extracted directly from NAIF's
 * own source (zzfdat.c in the OpenSpace/Spice mirror of CSPICE) by
 * scripts/extract-body-fixed-frames.mjs -- not hand-transcribed. Do
 * not edit by hand; re-run that script instead.
 *
 * Each entry's \`classId\` is the lookup key used to find this frame's
 * orientation data -- either a loaded binary PCK segment whose frame
 * ID equals \`classId\`, or (falling back, per NAIF's documented
 * priority) a loaded text PCK's \`BODY<classId>_POLE_RA/DEC/PM\`
 * constants. For every one of these built-in frames, \`classId\` is
 * simply the NAIF body ID the frame is fixed to (e.g. IAU_MOON's
 * \`classId\` is 301) -- see src/frames.js and src/bodyOrientation.js.
 *
 * The 21 built-in *inertial* frames (J2000, ...) are a separate table
 * -- see src/data/inertialFrames.js / extract-inertial-frames.mjs.
 */
export const BODY_FIXED_FRAMES = ${JSON.stringify(frames, null, 2)};
`;

const outPath = path.join(here, '../src/data/bodyFixedFrames.js');
fs.writeFileSync(outPath, out);
console.log(`Wrote ${frames.length} body-fixed frames to ${path.relative(process.cwd(), outPath)}`);
