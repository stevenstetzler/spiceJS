/**
 * Reference frame name/ID resolution and rotation: NAIF's 21 built-in
 * *inertial* frames (src/data/inertialFrames.js), NAIF's ~123 built-in
 * *body-fixed* frames driven by the classic PCK orientation formula
 * (IAU_MOON, IAU_EARTH, ...; src/data/bodyFixedFrames.js), and any
 * frame defined by a loaded Frame Kernel (FK) -- class 2 (PCK-driven,
 * e.g. `MOON_PA_DE440`) or class 4 (TK, fixed-offset, e.g.
 * `MOON_ME_DE440_ME421`).
 *
 * Every non-inertial frame ultimately resolves to a rotation matrix
 * *from that frame to J2000* plus its time derivative (zero for
 * inertial and TK frames, which don't rotate relative to J2000 or
 * their relative frame): `resolveToJ2000()`. `rotateState()` combines
 * two such resolutions to rotate a position/velocity pair between any
 * two supported frames.
 *
 * Not supported: CK (spacecraft-orientation), dynamic, and switch
 * frames, and the one built-in class 4 frame in NAIF's table
 * (`EARTH_FIXED`, a hardcoded ITRF93-relative frame, not PCK-driven).
 */
import { INERTIAL_FRAMES } from './data/inertialFrames.js';
import { BODY_FIXED_FRAMES } from './data/bodyFixedFrames.js';
import { findPckSegment, evaluateSegment as evaluatePckSegment } from './pck.js';
import { classicEulerAngles } from './bodyOrientation.js';
import { tipmFromEulerAngles, composeAxisRotations, transpose3, multiply3 } from './math/eulerFrame.js';
import { globalPool } from './pool.js';

const J2000 = 1;
const HALF_PI = Math.PI / 2;
const ARCSEC_TO_RAD = Math.PI / (180 * 3600);

const INERTIAL_BY_ID = new Map(INERTIAL_FRAMES.map((f) => [f.id, f]));
const INERTIAL_BY_NAME = new Map(INERTIAL_FRAMES.map((f) => [f.name.toUpperCase(), f]));
const BODY_FIXED_BY_ID = new Map(BODY_FIXED_FRAMES.map((f) => [f.id, f]));
const BODY_FIXED_BY_NAME = new Map(BODY_FIXED_FRAMES.map((f) => [f.name.toUpperCase(), f]));

function zero3() {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
}

function add3(a, b) {
  return [
    [a[0][0] + b[0][0], a[0][1] + b[0][1], a[0][2] + b[0][2]],
    [a[1][0] + b[1][0], a[1][1] + b[1][1], a[1][2] + b[1][2]],
    [a[2][0] + b[2][0], a[2][1] + b[2][1], a[2][2] + b[2][2]],
  ];
}

function multiplyVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/**
 * Resolve a frame name (case-insensitive) to its NAIF frame ID. Looks
 * in a loaded FK's `FRAME_<NAME>` pool variable first (matching real
 * SPICE's priority -- an FK can add or override frame names), then
 * the 21 built-in inertial frames, then the ~123 built-in body-fixed
 * frames.
 *
 * @param {string} name
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number}
 */
export function frameId(name, pool = globalPool) {
  if (typeof name !== 'string') {
    throw new TypeError(`frameId: expected a string, got ${typeof name}`);
  }
  const trimmed = name.trim().toUpperCase();

  if (pool) {
    const values = pool.getValues(`FRAME_${trimmed}`);
    if (values) return Number(values[0]);
  }

  const inertial = INERTIAL_BY_NAME.get(trimmed);
  if (inertial) return inertial.id;

  const bodyFixed = BODY_FIXED_BY_NAME.get(trimmed);
  if (bodyFixed) return bodyFixed.id;

  throw new Error(
    `frameId: "${name}" is not a recognized frame -- not one of the 21 built-in inertial frames, one of ` +
      'the built-in body-fixed (IAU_*) frames, or a FRAME_<name> defined by a loaded frame kernel'
  );
}

/**
 * The NAIF body ID frame `id` is centered on, or `null` for one of
 * the 21 built-in inertial frames (which aren't tied to any one body).
 * Used by spkez()'s `ref` handling to pick the right epoch for
 * evaluating a non-inertial frame's orientation under light-time
 * correction (NAIF's spkez.c: the frame is evaluated at `et +
 * ltsign*ltcent`, where `ltcent` is 0 if the frame is centered on the
 * observer, the already-computed target light time if centered on the
 * target, or a fresh light-time computation to the frame's center
 * otherwise).
 *
 * @param {number} id
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number | null}
 */
export function frameCenter(id, pool = globalPool) {
  if (INERTIAL_BY_ID.has(id)) return null;

  const centerValues = pool ? pool.getValues(`FRAME_${id}_CENTER`) : undefined;
  if (centerValues) return Number(centerValues[0]);

  const bodyFixed = BODY_FIXED_BY_ID.get(id);
  if (bodyFixed) return bodyFixed.classId; // every built-in body-fixed frame's center equals its classId

  throw new Error(`frames: cannot determine the center of frame ${id} (not built-in, and no FRAME_${id}_CENTER)`);
}

/**
 * Look up how frame `id` is defined: built-in inertial (class 1),
 * built-in body-fixed (class 2, via the classic PCK formula or a
 * matching loaded binary PCK segment), or FK-defined (class 2 or 4,
 * from `FRAME_<id>_CLASS`/`FRAME_<id>_CLASS_ID`/`TKFRAME_<id>_*` pool
 * variables).
 */
function frameDefinition(id, pool) {
  if (INERTIAL_BY_ID.has(id)) return { class: 1 };

  const classValues = pool ? pool.getValues(`FRAME_${id}_CLASS`) : undefined;
  if (classValues) {
    const cls = Number(classValues[0]);
    if (cls === 2) {
      const classIdValues = pool.getValues(`FRAME_${id}_CLASS_ID`);
      if (!classIdValues) {
        throw new Error(`frames: FRAME_${id}_CLASS is 2 (PCK) but FRAME_${id}_CLASS_ID is not set`);
      }
      return { class: 2, classId: Number(classIdValues[0]) };
    }
    if (cls === 4) return { class: 4 };
    throw new Error(
      `frames: frame ${id} has FRAME_${id}_CLASS=${cls} -- only class 2 (PCK) and class 4 (TK, fixed-offset) ` +
        'frames are supported (CK/dynamic/switch frames are not)'
    );
  }

  const bodyFixed = BODY_FIXED_BY_ID.get(id);
  if (bodyFixed) return { class: 2, classId: bodyFixed.classId };

  throw new Error(
    `frames: frame ID ${id} is not one of the built-in inertial or body-fixed frames, and no ` +
      `FRAME_${id}_CLASS is defined by a loaded frame kernel`
  );
}

function requireEt(et, id) {
  if (typeof et !== 'number' || !Number.isFinite(et)) {
    throw new Error(`frames: an ephemeris time (et) is required to resolve non-inertial frame ${id}`);
  }
}

/** This body's orientation (TIPM/DTIPM, inertial-to-body-fixed) and the ID of the frame TIPM is relative to. */
function tipmForClassId(classId, et, pool) {
  const segment = pool ? findPckSegment(pool, classId, et) : null;
  if (segment) {
    const { eulerAngles, eulerRates } = evaluatePckSegment(segment, et);
    const [phi, delta, w] = eulerAngles;
    const [dphi, ddelta, dw] = eulerRates;
    return { ...tipmFromEulerAngles(phi, delta, w, dphi, ddelta, dw), baseFrameId: segment.refFrame };
  }

  const { ra, dec, w, dra, ddec, dw } = classicEulerAngles(classId, et, pool);
  const phi = ra + HALF_PI;
  const delta = HALF_PI - dec;
  const dphi = dra;
  const ddelta = -ddec;
  // The classic formula's constants are always referenced to J2000 in
  // the (only) case this implementation supports -- see
  // bodyOrientation.js's guard against BODY#_CONSTANTS_REF_FRAME/_EPOCH.
  return { ...tipmFromEulerAngles(phi, delta, w, dphi, ddelta, dw), baseFrameId: J2000 };
}

function readTkFrameLocalMatrix(id, pool) {
  const specValues = pool.getValues(`TKFRAME_${id}_SPEC`);
  if (!specValues) {
    throw new Error(`frames: frame ${id} is class 4 (TK) but TKFRAME_${id}_SPEC is not set`);
  }
  const spec = String(specValues[0]).toUpperCase();

  if (spec === 'MATRIX') {
    const values = pool.getValues(`TKFRAME_${id}_MATRIX`);
    if (!values || values.length !== 9) {
      throw new Error(`frames: TKFRAME_${id}_SPEC is 'MATRIX' but TKFRAME_${id}_MATRIX is missing or not 9 values`);
    }
    // Stored column-major (NAIF's own 3x3 convention: 9 values = column 1, column 2, column 3).
    return [
      [values[0], values[3], values[6]],
      [values[1], values[4], values[7]],
      [values[2], values[5], values[8]],
    ];
  }

  if (spec === 'ANGLES') {
    const angles = pool.getValues(`TKFRAME_${id}_ANGLES`);
    const axes = pool.getValues(`TKFRAME_${id}_AXES`);
    if (!angles || angles.length !== 3 || !axes || axes.length !== 3) {
      throw new Error(`frames: TKFRAME_${id}_SPEC is 'ANGLES' but TKFRAME_${id}_ANGLES/_AXES are missing`);
    }
    const units = pool.getValues(`TKFRAME_${id}_UNITS`);
    const unit = units ? String(units[0]).toUpperCase() : 'RADIANS';
    const toRad =
      unit === 'RADIANS' ? 1 : unit === 'DEGREES' ? Math.PI / 180 : unit === 'ARCSECONDS' ? ARCSEC_TO_RAD : null;
    if (toRad === null) {
      throw new Error(`frames: TKFRAME_${id}_UNITS "${units[0]}" is not one of RADIANS, DEGREES, ARCSECONDS`);
    }
    // eul2m_(angles[0],angles[1],angles[2], axes[0],axes[1],axes[2], rot):
    // rot = [angles[0]]_axes[0] [angles[1]]_axes[1] [angles[2]]_axes[2].
    return composeAxisRotations([
      { axis: Number(axes[0]), theta: Number(angles[0]) * toRad },
      { axis: Number(axes[1]), theta: Number(angles[1]) * toRad },
      { axis: Number(axes[2]), theta: Number(angles[2]) * toRad },
    ]);
  }

  throw new Error(`frames: TKFRAME_${id}_SPEC "${specValues[0]}" is not one of 'MATRIX', 'ANGLES'`);
}

/**
 * The rotation matrix (and its time derivative) taking a vector
 * expressed in frame `id` to the equivalent vector expressed in
 * J2000: `{ matrix, dmatrix }`. `dmatrix` is the all-zero matrix for
 * inertial and TK (fixed-offset) frames -- true derivatives only
 * arise for PCK-driven (class 2) frames.
 */
function resolveToJ2000(id, et, pool) {
  const inertial = INERTIAL_BY_ID.get(id);
  if (inertial) {
    // matrixFromJ2000 takes J2000 -> that frame; this needs the inverse.
    return { matrix: transpose3(inertial.matrixFromJ2000), dmatrix: zero3() };
  }

  const def = frameDefinition(id, pool);

  if (def.class === 2) {
    requireEt(et, id);
    const { tipm, dtipm, baseFrameId } = tipmForClassId(def.classId, et, pool);
    // TIPM: base -> body-fixed. This needs the inverse (body-fixed -> base), then composed with base -> J2000.
    const bodyToBase = transpose3(tipm);
    const dBodyToBase = transpose3(dtipm);
    if (baseFrameId === J2000) {
      return { matrix: bodyToBase, dmatrix: dBodyToBase };
    }
    const { matrix: baseToJ2000, dmatrix: dBaseToJ2000 } = resolveToJ2000(baseFrameId, et, pool);
    return {
      matrix: multiply3(baseToJ2000, bodyToBase),
      dmatrix: add3(multiply3(dBaseToJ2000, bodyToBase), multiply3(baseToJ2000, dBodyToBase)),
    };
  }

  // class === 4 (TK, fixed-offset).
  const relativeValues = pool.getValues(`TKFRAME_${id}_RELATIVE`);
  if (!relativeValues) {
    throw new Error(`frames: frame ${id} is class 4 (TK) but TKFRAME_${id}_RELATIVE is not set`);
  }
  const relativeId = frameId(String(relativeValues[0]), pool);
  const local = readTkFrameLocalMatrix(id, pool); // this -> relative
  const { matrix: relativeToJ2000, dmatrix: dRelativeToJ2000 } = resolveToJ2000(relativeId, et, pool);
  return {
    matrix: multiply3(relativeToJ2000, local),
    dmatrix: multiply3(dRelativeToJ2000, local), // local is constant, so no extra product-rule term
  };
}

/**
 * Rotate a position/velocity pair from frame `fromId` to frame
 * `toId`, at ephemeris time `et`. Supports the 21 built-in inertial
 * frames, the built-in body-fixed (IAU_*) frames, and any frame
 * defined by a loaded frame kernel (FK). `et`/`pool` may be omitted
 * only when both frames are inertial (their rotation doesn't depend
 * on either).
 *
 * @param {number} fromId
 * @param {number} toId
 * @param {number[]} position
 * @param {number[]} velocity
 * @param {number} [et] - TDB seconds past J2000
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {{ position: number[], velocity: number[] }}
 */
export function rotateState(fromId, toId, position, velocity, et, pool = globalPool) {
  if (fromId === toId) {
    return { position: position.slice(), velocity: velocity.slice() };
  }

  const from = resolveToJ2000(fromId, et, pool);
  const to = resolveToJ2000(toId, et, pool);
  const toJ2000ToTarget = transpose3(to.matrix);
  const dToJ2000ToTarget = transpose3(to.dmatrix);

  const r = multiply3(toJ2000ToTarget, from.matrix);
  const dr = add3(multiply3(dToJ2000ToTarget, from.matrix), multiply3(toJ2000ToTarget, from.dmatrix));

  return {
    position: multiplyVec(r, position),
    velocity: add3Vec(multiplyVec(r, velocity), multiplyVec(dr, position)),
  };
}

function add3Vec(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
