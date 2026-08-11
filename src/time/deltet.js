/**
 * DELTA_ET: the offset between ephemeris time (ET / TDB) and UTC or
 * TDT, computed from the DELTET/* variables a leapseconds kernel
 * (LSK) loads into the kernel pool. This reimplements the equation
 * documented in NAIF's LSK files and in the "Time" required reading:
 *
 *   ET  = TT + K * sin(E)                     (TDB, given TT)
 *   TT  = UTC + DELTA_AT + DELTA_T_A           (TT, given UTC)
 *   E   = M0 + M1 * T + EB * sin(M0 + M1 * T)
 *
 * where T (here approximated by TT itself) and UTC are both expressed
 * as continuous seconds past J2000 (see calendar.js), and DELTA_AT is
 * the whole-second TAI-UTC leap second count in effect at the given
 * UTC epoch. TDT is just another name for TT, so converting a TDT
 * string only needs the first equation -- no DELTA_AT lookup, and no
 * DELTA_T_A, since a TDT-labeled clock reading already *is* TT.
 */

const LEAPSECONDS_VARS = ['DELTET/DELTA_T_A', 'DELTET/K', 'DELTET/EB', 'DELTET/M', 'DELTET/DELTA_AT'];
const PERIODIC_TERM_VARS = ['DELTET/K', 'DELTET/EB', 'DELTET/M'];

function requirePoolVar(pool, name) {
  const values = pool.getValues(name);
  if (!values) {
    throw new Error(
      `No "${name}" kernel pool variable is defined. Load a leapseconds kernel ` +
        '(e.g. naif0012.tls) with furnsh() before converting UTC/TDT time strings.'
    );
  }
  return values;
}

/** Build the sorted {leapSeconds, epoch} leap-second table from the pool. */
function deltaAtTable(pool) {
  const raw = requirePoolVar(pool, 'DELTET/DELTA_AT');
  if (raw.length === 0 || raw.length % 2 !== 0) {
    throw new Error('DELTET/DELTA_AT kernel pool variable is malformed (expected leap-second/epoch pairs)');
  }
  const table = [];
  for (let i = 0; i < raw.length; i += 2) {
    table.push({ leapSeconds: raw[i], epoch: raw[i + 1] });
  }
  table.sort((a, b) => a.epoch - b.epoch);
  return table;
}

/**
 * Look up TAI-UTC (in whole seconds) in effect at a given instant,
 * expressed as continuous UTC seconds past J2000.
 */
export function lookupDeltaAt(utcContinuousSeconds, pool) {
  const table = deltaAtTable(pool);
  if (utcContinuousSeconds < table[0].epoch) {
    throw new RangeError(
      'spiceJS does not support UTC epochs before the start of the DELTA_AT table in the loaded ' +
        `leapseconds kernel (its earliest entry is ${table[0].leapSeconds} leap seconds).`
    );
  }
  let deltaAt = table[0].leapSeconds;
  for (const entry of table) {
    if (entry.epoch > utcContinuousSeconds) break;
    deltaAt = entry.leapSeconds;
  }
  return deltaAt;
}

/**
 * Confirm the pool has everything a leapseconds kernel should have
 * provided for UTC conversions. Throws a clear error naming the first
 * missing variable.
 */
export function assertLeapsecondsLoaded(pool) {
  for (const name of LEAPSECONDS_VARS) {
    requirePoolVar(pool, name);
  }
}

/** As assertLeapsecondsLoaded(), but only for what TT<->TDB needs (K, EB, M). */
function assertPeriodicTermVars(pool) {
  for (const name of PERIODIC_TERM_VARS) {
    requirePoolVar(pool, name);
  }
}

/**
 * Convert TT (Terrestrial Time, i.e. TDT) seconds past J2000 to
 * ephemeris time (ET / TDB) seconds past J2000: ET = TT + K*sin(E).
 */
export function ttToEt(tt, pool) {
  assertPeriodicTermVars(pool);
  const k = pool.getValues('DELTET/K')[0];
  const eb = pool.getValues('DELTET/EB')[0];
  const [m0, m1] = pool.getValues('DELTET/M');

  const e = m0 + m1 * tt + eb * Math.sin(m0 + m1 * tt);
  return tt + k * Math.sin(e);
}

/**
 * Inverse of ttToEt(): ET seconds past J2000 -> TT seconds past
 * J2000. The periodic term is inverted with a few fixed-point
 * iterations (its amplitude is at most ~1.7 ms, so this converges
 * essentially immediately).
 */
export function etToTt(et, pool) {
  assertPeriodicTermVars(pool);
  const k = pool.getValues('DELTET/K')[0];
  const eb = pool.getValues('DELTET/EB')[0];
  const [m0, m1] = pool.getValues('DELTET/M');

  let tt = et;
  for (let i = 0; i < 4; i++) {
    const e = m0 + m1 * tt + eb * Math.sin(m0 + m1 * tt);
    tt = et - k * Math.sin(e);
  }
  return tt;
}

/**
 * Convert continuous UTC seconds past J2000 to ephemeris time (ET /
 * TDB) seconds past J2000, using the leapseconds kernel loaded into
 * `pool`.
 */
export function utcToEt(utcContinuousSeconds, pool) {
  assertLeapsecondsLoaded(pool);
  const deltaAt = lookupDeltaAt(utcContinuousSeconds, pool);
  const deltaTA = pool.getValues('DELTET/DELTA_T_A')[0];
  return ttToEt(utcContinuousSeconds + deltaAt + deltaTA, pool);
}

/**
 * Inverse of utcToEt(): ET seconds past J2000 -> continuous UTC
 * seconds past J2000.
 */
export function etToUtc(et, pool) {
  assertLeapsecondsLoaded(pool);
  const deltaTA = pool.getValues('DELTET/DELTA_T_A')[0];
  const tt = etToTt(et, pool);

  const utcPlusDeltaAt = tt - deltaTA;
  // DELTA_AT changes are integer seconds at day boundaries, so using
  // utcPlusDeltaAt (off from the true UTC value by at most ~37s)
  // against the table is safe for bracket selection.
  const deltaAt = lookupDeltaAt(utcPlusDeltaAt, pool);
  return utcPlusDeltaAt - deltaAt;
}
