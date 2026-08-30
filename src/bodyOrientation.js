/**
 * The classic text-PCK orientation formula (NAIF's bodeul.c, the
 * fallback path taken when no binary PCK segment covers the requested
 * body/time -- see frames.js): a body's pole right ascension/
 * declination and prime-meridian rotation as quadratic polynomials in
 * time, plus optional periodic ("nutation/precession") correction
 * terms driven by the parent planetary system's phase angles.
 *
 *   RA  = RA0  + RA1*t   + RA2*t*t   + sum_i a(i) * sin(theta_i)
 *   DEC = DEC0 + DEC1*t  + DEC2*t*t  + sum_i d(i) * cos(theta_i)
 *   W   = W0   + W1*d    + W2*d*d    + sum_i w(i) * sin(theta_i)
 *   theta_i = sum_j THETA(i,j) * t^j
 *
 * `t` = TDB Julian centuries past J2000, `d` = TDB days past J2000
 * (note W's own polynomial runs in days, not centuries, even though
 * the shared theta_i phase angles still run in centuries). RA/DEC/W
 * and the theta_i/amplitude coefficients are all in *degrees* in the
 * kernel; only the final result is converted to radians.
 *
 * Kernel pool variables (all from a loaded text PCK, e.g. pck00010.tpc):
 *   BODY<id>_POLE_RA / _POLE_DEC / _PM      -- [c0, c1, c2] (degrees, deg/century or deg/day, deg/century^2 or deg/day^2)
 *   BODY<id>_NUT_PREC_RA / _DEC / _PM       -- [a(1), a(2), ...] (degrees) -- optional
 *   BODY<parentId>_NUT_PREC_ANGLES          -- [THETA0(1), THETA1(1), THETA0(2), THETA1(2), ...] (degrees) -- optional
 *   BODY<parentId>_MAX_PHASE_DEGREE         -- overrides the default degree-1 (2-coefficient) theta_i polynomial -- optional
 *
 * `parentId` is NAIF's zzbodbry_ rule: a 3-digit body (100-999) ->
 * `floor(id/100)`; a 5-digit extended satellite ID (10000-99999) ->
 * `floor(id/10000)`; anything else (barycenters 1-9, the Sun, small
 * bodies, ...) -> the body's own ID (confirmed against zzbodbry.c).
 *
 * Not implemented: `BODY#_CONSTANTS_REF_FRAME`/`_JED_EPOCH` (constants
 * defined relative to a frame/epoch other than J2000) -- rare, and a
 * clear error is raised rather than silently ignoring them.
 */

const DEG_TO_RAD = Math.PI / 180;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_CENTURY = SECONDS_PER_DAY * 36525;
const HALF_PI = Math.PI / 2;
const DT_DSEC = 1 / SECONDS_PER_CENTURY; // d(t [centuries]) / d(seconds)
const DD_DSEC = 1 / SECONDS_PER_DAY; // d(d [days]) / d(seconds)

/** NAIF's zzbodbry_: the planetary-system barycenter ID a body's orientation constants are keyed to. */
function parentBodyId(id) {
  if (id >= 100 && id <= 999) return Math.floor(id / 100);
  if (id >= 10000 && id <= 99999) return Math.floor(id / 10000);
  return id;
}

/** Pool array, zero-padded/truncated to exactly 3 entries (POLE_RA/POLE_DEC/PM may define fewer than 3). */
function readQuadraticCoeffs(pool, name) {
  const values = pool.getValues(name);
  if (!values) return null;
  const coeffs = [0, 0, 0];
  for (let i = 0; i < Math.min(3, values.length); i++) coeffs[i] = Number(values[i]);
  return coeffs;
}

function readNumberArray(pool, name) {
  const values = pool.getValues(name);
  return values ? values.map(Number) : [];
}

function assertNoUnsupportedEpochOrFrame(pool, parentId) {
  for (const suffix of ['_CONSTANTS_REF_FRAME', '_CONSTS_REF_FRAME', '_CONSTANTS_JED_EPOCH', '_CONSTS_JED_EPOCH']) {
    if (pool.has(`BODY${parentId}${suffix}`)) {
      throw new Error(
        `bodyOrientation: BODY${parentId}${suffix} is set, but orientation constants referenced to a ` +
          'frame or epoch other than J2000 are not supported yet'
      );
    }
  }
}

/**
 * The classic text-PCK orientation formula, evaluated (and
 * differentiated with respect to `et`) at `et`.
 *
 * @param {number} classId - the body ID whose BODY<classId>_POLE_RA
 *   etc. constants to use (for the built-in IAU_<BODY> frames this is
 *   the frame's associated body; see src/data/bodyFixedFrames.js)
 * @param {number} et - TDB seconds past J2000
 * @param {import('./pool.js').KernelPool} pool
 * @returns {{ ra: number, dec: number, w: number, dra: number, ddec: number, dw: number }}
 *   radians and radians/second
 */
export function classicEulerAngles(classId, et, pool) {
  const rcoef = readQuadraticCoeffs(pool, `BODY${classId}_POLE_RA`);
  if (!rcoef) {
    throw new Error(
      `bodyOrientation: no BODY${classId}_POLE_RA in the kernel pool -- load a text PCK (e.g. pck00010.tpc) ` +
        `that defines orientation constants for body ${classId}`
    );
  }
  const dcoef = readQuadraticCoeffs(pool, `BODY${classId}_POLE_DEC`) ?? [0, 0, 0];
  const wcoef = readQuadraticCoeffs(pool, `BODY${classId}_PM`) ?? [0, 0, 0];

  const parentId = parentBodyId(classId);
  assertNoUnsupportedEpochOrFrame(pool, parentId);

  const thetaCoef = readNumberArray(pool, `BODY${parentId}_NUT_PREC_ANGLES`);
  const degreeValues = readQuadraticCoeffs(pool, `BODY${parentId}_MAX_PHASE_DEGREE`);
  const nphsco = degreeValues ? Math.round(degreeValues[0]) + 1 : 2;
  const nphase = thetaCoef.length / nphsco;
  if (!Number.isInteger(nphase)) {
    throw new Error(
      `bodyOrientation: BODY${parentId}_NUT_PREC_ANGLES has ${thetaCoef.length} entries, not a multiple of ` +
        `the phase-angle polynomial degree+1 (${nphsco})`
    );
  }

  const ac = readNumberArray(pool, `BODY${classId}_NUT_PREC_RA`);
  const dc = readNumberArray(pool, `BODY${classId}_NUT_PREC_DEC`);
  const wc = readNumberArray(pool, `BODY${classId}_NUT_PREC_PM`);
  const maxTerms = Math.max(ac.length, dc.length, wc.length);
  if (maxTerms > nphase) {
    throw new Error(
      `bodyOrientation: body ${classId} needs ${maxTerms} phase angles but BODY${parentId}_NUT_PREC_ANGLES ` +
        `only defines ${nphase}`
    );
  }

  const d = et / SECONDS_PER_DAY;
  const t = d / 36525;

  let raDeg = rcoef[0] + t * (rcoef[1] + t * rcoef[2]);
  let decDeg = dcoef[0] + t * (dcoef[1] + t * dcoef[2]);
  let wDeg = wcoef[0] + d * (wcoef[1] + d * wcoef[2]);
  let dRaDeg_dt = rcoef[1] + 2 * t * rcoef[2]; // d(raDeg)/dt [centuries]
  let dDecDeg_dt = dcoef[1] + 2 * t * dcoef[2];
  let dWDeg_dd = wcoef[1] + 2 * d * wcoef[2]; // d(wDeg)/dd [days]

  const sinTheta = new Array(nphase);
  const cosTheta = new Array(nphase);
  const dThetaRad_dt = new Array(nphase); // d(theta_i in RADIANS, since it multiplies sin/cos below)/dt [centuries]
  for (let i = 0; i < nphase; i++) {
    // theta_i(t) = sum_j t^j * coef[j]; d(theta_i)/dt = sum_{j>=1} j*t^(j-1) * coef[j] (still in degrees/t here).
    let thetaDeg = 0;
    let thetaRateDeg = 0;
    let tPower = 1; // t^j
    let tPowerMinusOne = 1; // t^(j-1), only meaningful for j >= 1
    for (let j = 0; j < nphsco; j++) {
      const coeff = thetaCoef[i * nphsco + j];
      thetaDeg += tPower * coeff;
      if (j >= 1) thetaRateDeg += j * tPowerMinusOne * coeff;
      tPowerMinusOne = tPower;
      tPower *= t;
    }
    const thetaRad = thetaDeg * DEG_TO_RAD;
    sinTheta[i] = Math.sin(thetaRad);
    cosTheta[i] = Math.cos(thetaRad);
    // d/dt sin(theta_rad(t)) = cos(theta_rad) * d(theta_rad)/dt -- the
    // chain rule needs theta's *own* rate in radians here, even though
    // amplitudes (ac/dc/wc below) stay in degrees throughout.
    dThetaRad_dt[i] = thetaRateDeg * DEG_TO_RAD;
  }

  for (let i = 0; i < ac.length; i++) raDeg += ac[i] * sinTheta[i];
  for (let i = 0; i < dc.length; i++) decDeg += dc[i] * cosTheta[i];
  for (let i = 0; i < wc.length; i++) wDeg += wc[i] * sinTheta[i];

  for (let i = 0; i < ac.length; i++) dRaDeg_dt += ac[i] * cosTheta[i] * dThetaRad_dt[i];
  for (let i = 0; i < dc.length; i++) dDecDeg_dt -= dc[i] * sinTheta[i] * dThetaRad_dt[i];
  for (let i = 0; i < wc.length; i++) dWDeg_dd += wc[i] * cosTheta[i] * dThetaRad_dt[i] * (DT_DSEC / DD_DSEC);

  const ra = raDeg * DEG_TO_RAD;
  const dec = decDeg * DEG_TO_RAD;
  const w = wDeg * DEG_TO_RAD;
  const dra = dRaDeg_dt * DT_DSEC * DEG_TO_RAD;
  const ddec = dDecDeg_dt * DT_DSEC * DEG_TO_RAD;
  const dw = dWDeg_dd * DD_DSEC * DEG_TO_RAD;

  return { ra, dec, w, dra, ddec, dw };
}
