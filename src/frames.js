/**
 * Reference frame name/ID resolution and rotation, for NAIF's 21
 * built-in *inertial* frames (src/data/inertialFrames.js, extracted
 * from source -- see scripts/extract-inertial-frames.mjs). Body-fixed
 * frames (IAU_MARS, IAU_EARTH, ...) aren't supported yet -- they need
 * text PCK orientation data and a time-dependent rotation formula,
 * not just a fixed matrix.
 */
import { INERTIAL_FRAMES } from './data/inertialFrames.js';

const BY_ID = new Map(INERTIAL_FRAMES.map((f) => [f.id, f]));
const BY_NAME = new Map(INERTIAL_FRAMES.map((f) => [f.name.toUpperCase(), f]));

/**
 * Resolve a frame name (case-insensitive) to its NAIF frame ID.
 * @param {string} name
 * @returns {number}
 */
export function frameId(name) {
  if (typeof name !== 'string') {
    throw new TypeError(`frameId: expected a string, got ${typeof name}`);
  }
  const frame = BY_NAME.get(name.trim().toUpperCase());
  if (!frame) {
    throw new Error(
      `frameId: "${name}" is not one of the built-in inertial frames (${INERTIAL_FRAMES.map((f) => f.name).join(
        ', '
      )}) -- body-fixed frames (IAU_*) and frame-kernel-defined frames aren't supported yet`
    );
  }
  return frame.id;
}

function requireInertial(id) {
  const frame = BY_ID.get(id);
  if (!frame) {
    throw new Error(
      `frames: frame ID ${id} is not one of the 21 built-in inertial frames -- body-fixed frames ` +
        '(IAU_*) and frame-kernel-defined frames are not supported yet'
    );
  }
  return frame;
}

function multiplyVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function multiplyMat(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

/**
 * Rotation matrix taking a vector expressed in inertial frame `fromId`
 * to the equivalent vector expressed in inertial frame `toId`.
 */
function rotationMatrix(fromId, toId) {
  if (fromId === toId) {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }
  const from = requireInertial(fromId);
  const to = requireInertial(toId);
  // matrixFromJ2000 takes J2000 -> that frame; from^T undoes fromId -> J2000.
  const fromT = [
    [from.matrixFromJ2000[0][0], from.matrixFromJ2000[1][0], from.matrixFromJ2000[2][0]],
    [from.matrixFromJ2000[0][1], from.matrixFromJ2000[1][1], from.matrixFromJ2000[2][1]],
    [from.matrixFromJ2000[0][2], from.matrixFromJ2000[1][2], from.matrixFromJ2000[2][2]],
  ];
  return multiplyMat(to.matrixFromJ2000, fromT);
}

/**
 * Rotate a position/velocity pair from inertial frame `fromId` to
 * inertial frame `toId`. Since both frames are non-rotating, the same
 * fixed matrix applies to position and velocity alike -- no angular-
 * velocity coupling term (that's specific to non-inertial frames,
 * which aren't supported here).
 *
 * @param {number} fromId
 * @param {number} toId
 * @param {number[]} position
 * @param {number[]} velocity
 * @returns {{ position: number[], velocity: number[] }}
 */
export function rotateState(fromId, toId, position, velocity) {
  const r = rotationMatrix(fromId, toId);
  return { position: multiplyVec(r, position), velocity: multiplyVec(r, velocity) };
}
