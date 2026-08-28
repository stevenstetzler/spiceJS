/**
 * Test-only builder for a synthetic `KPL/SCLK` text kernel string --
 * needs no binary encoding at all (unlike `writeSpk.js`/`writeCk.js`):
 * a real SCLK kernel is just ordinary text-kernel variable assignments
 * (see `sclk.js`'s own doc comment for exactly which ones), already
 * loadable through the existing `furnsh()`/`load()` -> `textKernel.js`
 * path with no changes needed anywhere in that chain.
 */

/**
 * @param {object} opts
 * @param {number} opts.sc - spacecraft/clock ID (negative, e.g. -100001)
 * @param {number[]} opts.moduli - one per clock field
 * @param {number[]} [opts.offsets] - one per clock field, defaults to all 0
 * @param {number} [opts.outputDelim] - 1='.' 2=':' 3='-' 4=',' 5=' ', defaults to 2 (':')
 * @param {Array<{start: number, stop: number}>} opts.partitions
 * @param {Array<{ticks: number, time: number, rate: number}>} opts.coefficients
 * @returns {string}
 */
export function writeSclkKernel({ sc, moduli, offsets, outputDelim = 2, partitions, coefficients }) {
  const off = offsets ?? moduli.map(() => 0);
  // Real SCLK variable names use |sc|, not sc itself -- confirmed
  // directly against real CSPICE (see sclk.js's own doc comment).
  const id = Math.abs(sc);
  const lines = [
    'KPL/SCLK',
    '\\begindata',
    `SCLK_DATA_TYPE_${id} = ( 1 )`,
    `SCLK01_TIME_SYSTEM_${id} = ( 1 )`,
    `SCLK01_N_FIELDS_${id} = ( ${moduli.length} )`,
    `SCLK01_MODULI_${id} = ( ${moduli.join(', ')} )`,
    `SCLK01_OFFSETS_${id} = ( ${off.join(', ')} )`,
    `SCLK01_OUTPUT_DELIM_${id} = ( ${outputDelim} )`,
    `SCLK_PARTITION_START_${id} = ( ${partitions.map((p) => p.start).join(', ')} )`,
    `SCLK_PARTITION_END_${id} = ( ${partitions.map((p) => p.stop).join(', ')} )`,
    `SCLK01_COEFFICIENTS_${id} = ( ${coefficients.flatMap((c) => [c.ticks, c.time, c.rate]).join(', ')} )`,
    '\\begintext',
  ];
  return lines.join('\n') + '\n';
}
