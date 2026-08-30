/**
 * SCLK: spacecraft clock time strings, encoded ("ticks") and continuous
 * (TDB) time -- SPICE's SCENCD/SCDECD/SCT2E/SCE2C/SCE2T/SCPART, ported
 * from the type-1 umbrella `sc01.c` (`sctk01`/`scfm01`/`scte01`/
 * `scet01`/`scec01`/`scpr01` entry points) and `scencd.c` in the
 * OpenSpace/Spice mirror -- the only SCLK data type NAIF has ever
 * actually shipped kernels for (a type-2 dispatch exists in real
 * CSPICE too, but with no real-world kernels; a kernel claiming it is
 * a clear "not supported" error here, same as time system 2/TDT below).
 *
 * A `KPL/SCLK` text kernel is an ordinary text kernel -- `textKernel.js`'s
 * generic `KPL/*` parser already loads it into the pool via
 * `furnsh()`/`load()`, no changes needed there. Every function below
 * just reads the pool variables a real SCLK kernel sets for spacecraft
 * `sc` (the *negative* NAIF ID of the spacecraft or clock owner, e.g.
 * -82 for Cassini -- not an instrument ID; see `ck.js`'s
 * `CK_<inst>_SCLK` lookup for how an instrument ID maps to one).
 * **The variable names themselves use `sc`'s absolute value**, even
 * though every function here (matching real CSPICE) takes the signed
 * `sc` -- confirmed directly against real CSPICE (spiceypy), not
 * assumed from the naming pattern every other kernel-pool convention
 * in this codebase follows (e.g. `CK_<inst>_SCLK` below uses signed
 * `inst`; `FRAME_<id>_CLASS` uses signed frame IDs) -- this one
 * variable family is genuinely the odd one out:
 *
 *   SCLK_DATA_TYPE_<|sc|>          must be 1
 *   SCLK01_TIME_SYSTEM_<|sc|>      must be 1 (TDB) -- see module doc above
 *   SCLK01_N_FIELDS_<|sc|>         number of clock string fields
 *   SCLK01_MODULI_<|sc|>           one modulus per field
 *   SCLK01_OFFSETS_<|sc|>          one starting offset per field
 *   SCLK01_OUTPUT_DELIM_<|sc|>     1='.' 2=':' 3='-' 4=',' 5=' '
 *   SCLK_PARTITION_START_<|sc|>    one start tick per partition
 *   SCLK_PARTITION_END_<|sc|>      one end tick per partition
 *   SCLK01_COEFFICIENTS_<|sc|>     flat [ticks, TDB-seconds, rate, ...]
 *                                 triplets, ascending by ticks
 *
 * A clock **string** is `[partition/]field1<delim>field2<delim>...` --
 * see `scEncode()`'s own doc comment for the partition/field grammar.
 * Encoded SCLK ("ticks", called `sclkdp` throughout, matching CSPICE's
 * own parameter name) is a single double: ticks since the start of
 * partition 1, running continuously across partition boundaries (a
 * clock reset starts a new partition; encoded SCLK doesn't reset with
 * it -- see `scEncode()`).
 */
import { globalPool } from './pool.js';

function requireVar(pool, name, sc) {
  // Real SCLK variable names use |sc|, not sc itself -- see this
  // module's own doc comment for how that was confirmed.
  const key = `${name}_${Math.abs(sc)}`;
  const values = pool.getValues(key);
  if (!values) throw new Error(`sclk: no SCLK kernel loaded for spacecraft ${sc} (pool variable ${key} is not set)`);
  return values;
}

const OUTPUT_DELIMS = { 1: '.', 2: ':', 3: '-', 4: ',', 5: ' ' };

/**
 * Every pool variable a type 1 SCLK needs, read and lightly validated.
 * Re-read on every call (matching this repo's convention elsewhere of
 * not caching kernel-pool state -- see e.g. `frames.js`) rather than
 * cached, since the pool can change between calls (a different/updated
 * SCLK kernel loaded).
 */
function readSclkConfig(sc, pool) {
  const dataType = Number(requireVar(pool, 'SCLK_DATA_TYPE', sc)[0]);
  if (dataType !== 1) {
    throw new Error(`sclk: spacecraft ${sc}'s clock is SCLK data type ${dataType} -- only type 1 is supported`);
  }
  const timeSystem = Number(requireVar(pool, 'SCLK01_TIME_SYSTEM', sc)[0]);
  if (timeSystem !== 1) {
    throw new Error(
      `sclk: spacecraft ${sc}'s clock kernel uses time system ${timeSystem} -- only time system 1 (TDB) is ` +
        'supported (time system 2/TDT needs a TDT<->TDB conversion this library does not have yet)'
    );
  }
  const moduli = requireVar(pool, 'SCLK01_MODULI', sc).map(Number);
  const offsets = requireVar(pool, 'SCLK01_OFFSETS', sc).map(Number);
  const nFields = moduli.length;
  if (offsets.length !== nFields) {
    throw new Error(`sclk: spacecraft ${sc}'s SCLK01_MODULI and SCLK01_OFFSETS have different lengths`);
  }
  const delimCode = Number(requireVar(pool, 'SCLK01_OUTPUT_DELIM', sc)[0]);
  const outputDelim = OUTPUT_DELIMS[delimCode];
  if (outputDelim === undefined) {
    throw new Error(`sclk: spacecraft ${sc}'s SCLK01_OUTPUT_DELIM_${sc} value ${delimCode} is not one of 1-5`);
  }
  const flatCoeffs = requireVar(pool, 'SCLK01_COEFFICIENTS', sc).map(Number);
  if (flatCoeffs.length % 3 !== 0 || flatCoeffs.length === 0) {
    throw new Error(`sclk: spacecraft ${sc}'s SCLK01_COEFFICIENTS_${sc} does not have a multiple-of-3 length`);
  }
  const coefficients = [];
  for (let i = 0; i < flatCoeffs.length; i += 3) {
    coefficients.push({ ticks: flatCoeffs[i], time: flatCoeffs[i + 1], rate: flatCoeffs[i + 2] });
  }

  // The place value of field i (1-indexed in the kernel's own
  // documentation, 0-indexed here) is the product of every later
  // field's modulus -- e.g. for Cassini's [RIM, fine] with moduli
  // [nRIM, 256], field 0's place value is 256 and field 1's is 1.
  const placeValues = new Array(nFields).fill(1);
  for (let i = nFields - 2; i >= 0; i--) placeValues[i] = placeValues[i + 1] * moduli[i + 1];
  // tikmsc: ticks per "1 unit of the most significant field" -- what a
  // kernel's own COEFFICIENTS rate (seconds per field-1 unit) is
  // divided by to get seconds per tick. Equal to placeValues[0].
  const tikmsc = placeValues[0];

  return { sc, moduli, offsets, nFields, outputDelim, coefficients, placeValues, tikmsc };
}

/**
 * Split a clock string's fields (after any partition prefix has
 * already been stripped) the way NAIF's `LPARSM` does for SCLK: on any
 * of the five delimiters `. : - , <space>`, with whitespace touching a
 * punctuation delimiter treated as part of that delimiter (so
 * `"10 : 5"` splits the same as `"10:5"`) and a doubled delimiter
 * (`"10::5"`) producing an empty field in between (a blank field means
 * "this component is 0", per `scencd.c`'s own documented behavior) --
 * this is a faithful re-derivation of that behavior, not a transcribed
 * port of LPARSM's own Fortran source, and is covered by crossval
 * against spiceypy for exactly that reason.
 */
function splitClockFields(fieldsPart) {
  const collapsed = fieldsPart.replace(/\s*([.:\-,])\s*/g, '$1').trim();
  if (collapsed === '') return [];
  return collapsed.split(/[.:\-,]|\s+/);
}

/**
 * Parse a clock string's fields (no partition prefix) into raw,
 * unadjusted-for-partition ticks (`SCTK01`/`sctiks_c`'s job) -- the
 * mixed-radix combination `sum((field_i - offset_i) * placeValue_i)`.
 * Used both by `scEncode()` below and standalone for parsing a
 * *duration* (e.g. a tolerance) expressed as a clock string, which has
 * no partition to resolve.
 *
 * @param {number} sc
 * @param {string} clockString - fields only, e.g. `"1465644281.171"`
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number} ticks
 */
export function scTicksForFields(sc, clockString, pool = globalPool) {
  const cfg = readSclkConfig(sc, pool);
  const fields = splitClockFields(clockString);
  if (fields.length === 0) {
    throw new Error(`sclk: SCLK string "${clockString}" has no components`);
  }
  if (fields.length > cfg.nFields) {
    throw new Error(`sclk: SCLK string "${clockString}" has ${fields.length} fields, spacecraft ${sc}'s clock only has ${cfg.nFields}`);
  }
  let ticks = 0;
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i] === '' ? cfg.offsets[i] : Number(fields[i]);
    if (Number.isNaN(raw)) {
      throw new Error(`sclk: could not parse SCLK component "${fields[i]}" (from "${clockString}") as a number`);
    }
    const value = raw - cfg.offsets[i];
    if (Math.round(value) < 0) {
      throw new Error(
        `sclk: component ${i + 1} in "${clockString}" (${raw}) is less than field ${i + 1}'s offset (${cfg.offsets[i]})`
      );
    }
    ticks += value * cfg.placeValues[i];
  }
  return ticks;
}

/**
 * Partition start/stop times (ticks) for spacecraft `sc`, straight
 * from `SCLK_PARTITION_START`/`SCLK_PARTITION_END` (`SCPART`).
 *
 * @param {number} sc
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {{ starts: number[], stops: number[] }}
 */
export function scPartitions(sc, pool = globalPool) {
  const starts = requireVar(pool, 'SCLK_PARTITION_START', sc).map((v) => Math.round(Number(v)));
  const stops = requireVar(pool, 'SCLK_PARTITION_END', sc).map((v) => Math.round(Number(v)));
  if (starts.length !== stops.length || starts.length === 0) {
    throw new Error(`sclk: spacecraft ${sc}'s SCLK_PARTITION_START/_END are missing or mismatched in length`);
  }
  return { starts, stops };
}

/** Cumulative duration of every partition up to and including index `i` (0-indexed), for the running-tick-offset math `scEncode()`/`scDecode()` share. */
function partitionCumulativeTotals(starts, stops) {
  const totals = [];
  let running = 0;
  for (let i = 0; i < starts.length; i++) {
    running += stops[i] - starts[i];
    totals.push(running);
  }
  return totals;
}

/**
 * Encode a spacecraft clock string to ticks (`SCENCD`). `sclkString` is
 * `[partition/]field1<delim>field2<delim>...` -- e.g. Cassini's
 * `"1/1465644281.171"` (partition 1, RIM field 1465644281, fine field
 * 171). The partition may be omitted (`"1465644281.171"`), in which
 * case the lowest-numbered partition whose own `[start,stop]` bounds
 * contain the field-parsed ticks is used; an explicit partition number
 * out of that partition's own bounds is an error, not silently
 * clamped.
 *
 * The returned value is monotonic across partition boundaries even
 * though a real spacecraft clock's own fields reset at each one: it's
 * `ticks - partitionStart + (sum of every earlier partition's own
 * duration)`, so `"1/<partition 1's end>"` and `"2/<partition 2's
 * start>"` -- the same physical instant, since one partition's end is
 * definitionally the next one's start -- encode to the same value.
 *
 * @param {number} sc
 * @param {string} sclkString
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number} ticks ("encoded SCLK", `sclkdp`)
 */
export function scEncode(sc, sclkString, pool = globalPool) {
  const { starts, stops } = scPartitions(sc, pool);
  const totals = partitionCumulativeTotals(starts, stops);

  const slash = sclkString.indexOf('/');
  let explicitPart = null;
  let fieldsPart = sclkString;
  if (slash !== -1) {
    if (slash === 0) throw new Error(`sclk: unable to parse the partition number from SCLK string "${sclkString}"`);
    if (slash === sclkString.length - 1) throw new Error(`sclk: no SCLK components follow the slash in "${sclkString}"`);
    const partStr = sclkString.slice(0, slash).trim();
    explicitPart = Number(partStr);
    if (!Number.isInteger(explicitPart)) {
      throw new Error(`sclk: unable to parse the partition number from SCLK string "${sclkString}"`);
    }
    fieldsPart = sclkString.slice(slash + 1);
  }

  const ticks = Math.round(scTicksForFields(sc, fieldsPart, pool));

  let part;
  if (explicitPart !== null) {
    if (explicitPart < 1 || explicitPart > starts.length) {
      throw new Error(`sclk: partition number ${explicitPart} from "${sclkString}" is not in the range 1 to ${starts.length}`);
    }
    part = explicitPart;
    const idx = part - 1;
    if (ticks < starts[idx] || ticks > stops[idx]) {
      throw new Error(`sclk: SCLK count "${sclkString}" does not fall in the boundaries of partition ${part}`);
    }
  } else {
    part = null;
    for (let i = 0; i < starts.length; i++) {
      if (ticks >= starts[i] && ticks <= stops[i]) {
        part = i + 1;
        break;
      }
    }
    if (part === null) {
      throw new Error(`sclk: SCLK count "${sclkString}" does not fall in the boundaries of any partition for spacecraft ${sc}`);
    }
  }

  const idx = part - 1;
  const priorTotal = idx > 0 ? totals[idx - 1] : 0;
  return ticks - starts[idx] + priorTotal;
}

function formatField(value, modulus) {
  const width = String(modulus - 1).length;
  return String(value).padStart(width, '0');
}

/**
 * Decode ticks back to a spacecraft clock string (`SCDECD`), the exact
 * inverse of `scEncode()`: finds which partition's cumulative range
 * contains `sclkdp`, recovers that partition's own raw ticks, then
 * mixed-radix-decomposes them into fields (each field zero-padded to
 * the width its modulus implies) joined by the kernel's configured
 * `SCLK01_OUTPUT_DELIM`, prefixed with `<partition>/`.
 *
 * @param {number} sc
 * @param {number} sclkdp
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {string}
 */
export function scDecode(sc, sclkdp, pool = globalPool) {
  const cfg = readSclkConfig(sc, pool);
  const { starts, stops } = scPartitions(sc, pool);

  let running = 0;
  let part = null;
  let ticks = 0;
  for (let i = 0; i < starts.length; i++) {
    const duration = stops[i] - starts[i];
    if (sclkdp >= running && sclkdp <= running + duration) {
      part = i + 1;
      ticks = sclkdp - running + starts[i];
      break;
    }
    running += duration;
  }
  if (part === null) {
    throw new Error(`sclk: encoded SCLK ${sclkdp} does not fall in the boundaries of any partition for spacecraft ${sc}`);
  }

  let remaining = Math.round(ticks);
  const fields = [];
  for (let i = 0; i < cfg.nFields; i++) {
    const component = Math.floor(remaining / cfg.placeValues[i]);
    remaining -= component * cfg.placeValues[i];
    fields.push(formatField(component + cfg.offsets[i], cfg.moduli[i]));
  }
  return `${part}/${fields.join(cfg.outputDelim)}`;
}

/** Binary search: the largest index `i` with `arr[i][key] <= value` (0 if `value` is less than every entry). */
function lastIndexAtOrBelow(arr, key, value) {
  if (value < arr[0][key]) return 0;
  let lower = 0;
  let upper = arr.length - 1;
  while (lower < upper) {
    const mid = Math.ceil((lower + upper) / 2);
    if (arr[mid][key] <= value) lower = mid;
    else upper = mid - 1;
  }
  return lower;
}

/**
 * Encoded SCLK (ticks) -> ephemeris time (`SCTE01`/`sct2e_c`): a
 * piecewise-linear interpolation through the kernel's own
 * `SCLK01_COEFFICIENTS` breakpoints. Throws if `sclkdp` is outside
 * `[first coefficient's ticks, total ticks across every partition]`
 * -- real clock-correlation data, not extrapolated indefinitely.
 *
 * @param {number} sc
 * @param {number} sclkdp
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number} TDB seconds past J2000
 */
export function sclkToEt(sc, sclkdp, pool = globalPool) {
  const cfg = readSclkConfig(sc, pool);
  const { starts, stops } = scPartitions(sc, pool);
  const maxTick = partitionCumulativeTotals(starts, stops).at(-1);
  if (sclkdp < cfg.coefficients[0].ticks || sclkdp > maxTick) {
    throw new Error(`sclk: encoded SCLK ${sclkdp} is out of range for spacecraft ${sc} (valid range is [${cfg.coefficients[0].ticks}, ${maxTick}])`);
  }
  const idx = lastIndexAtOrBelow(cfg.coefficients, 'ticks', sclkdp);
  const { ticks, time, rate } = cfg.coefficients[idx];
  if (rate <= 0) throw new Error(`sclk: invalid (non-positive) SCLK rate for spacecraft ${sc}`);
  return time + (rate / cfg.tikmsc) * (sclkdp - ticks);
}

/**
 * Ephemeris time -> encoded SCLK, continuous/fractional
 * (`SCEC01`/`sce2c_c`) -- the exact inverse of `sclkToEt()`. See
 * `etToSclkDiscrete()` for the nearest-whole-tick variant
 * (`SCET01`/`sce2t_c`).
 *
 * @param {number} sc
 * @param {number} et - TDB seconds past J2000
 * @param {import('./pool.js').KernelPool} [pool]
 * @returns {number} ticks
 */
export function etToSclk(sc, et, pool = globalPool) {
  const cfg = readSclkConfig(sc, pool);
  const { starts, stops } = scPartitions(sc, pool);
  if (et < cfg.coefficients[0].time) {
    throw new Error(`sclk: ET ${et} is out of range for spacecraft ${sc} (before the clock's first correlation point)`);
  }
  const idx = lastIndexAtOrBelow(cfg.coefficients, 'time', et);
  const { ticks, time, rate } = cfg.coefficients[idx];
  if (rate <= 0) throw new Error(`sclk: invalid (non-positive) SCLK rate for spacecraft ${sc}`);
  const sclkdp = ticks + (cfg.tikmsc / rate) * (et - time);
  const maxTick = partitionCumulativeTotals(starts, stops).at(-1);
  if (sclkdp > maxTick) {
    throw new Error(`sclk: ET ${et} is out of range for spacecraft ${sc} (past the clock's last partition)`);
  }
  return sclkdp;
}

/** `etToSclk()`, rounded to the nearest whole tick (`SCET01`/`sce2t_c`) -- what a CK pointing lookup's own tolerance search compares against. */
export function etToSclkDiscrete(sc, et, pool = globalPool) {
  return Math.round(etToSclk(sc, et, pool));
}
