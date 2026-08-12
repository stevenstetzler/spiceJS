// Minimal usage example for binary SPK (trajectory) kernels.
//
// This repo doesn't ship a real .bsp (they're tens-to-hundreds of MB,
// and naif.jpl.nasa.gov isn't reachable from every environment), so
// this demo builds a tiny synthetic one in memory using the same test
// helper spiceJS's own test suite uses (test/helpers/writeSpk.js) --
// see test/spk.test.js for more on how that works.
//
// To use a real kernel instead, skip the synthetic-file step below
// and just call:
//   furnsh('/path/to/de440s.bsp');
//   spkState(499, 10, someEt);              // Mars, direct segment only
//   spkez(399, 0, someEt, 'LT+S');           // Earth rel. SSB, chained + corrected
//
// Run from the repo root with:
//   node examples/spk.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { furnsh, spkState, spkez, spkSegments } from '../src/index.js';
import { writeSpk } from '../test/helpers/writeSpk.js';

// Two segments, the way a real DE-series kernel is laid out: Mars
// (499) moving in a straight line at 1 km/s in X relative to the Sun
// (10), and the Sun itself moving relative to the SSB (0) -- so
// "Mars relative to the SSB" needs the two-hop chain spkez() does.
const buffer = writeSpk({
  segments: [
    {
      target: 499,
      center: 10,
      frame: 1, // J2000
      type: 2, // Chebyshev, position-only (velocity is derived)
      startEt: -1800,
      stopEt: 1800,
      init: -1800,
      intlen: 3600,
      records: [{ mid: 0, radius: 1800, coeffsByAxis: [[1.0e8, 1800], [2.0e8, 0], [0, 0]] }],
    },
    {
      target: 10,
      center: 0,
      frame: 1,
      type: 2,
      startEt: -1800,
      stopEt: 1800,
      init: -1800,
      intlen: 3600,
      records: [{ mid: 0, radius: 1800, coeffsByAxis: [[500, 0], [-300, 0], [0, 0]] }],
    },
  ],
});

const tempFile = path.join(os.tmpdir(), `spicejs-example-${process.pid}.bsp`);
fs.writeFileSync(tempFile, buffer);

try {
  furnsh(tempFile);

  console.log('Loaded segments:', spkSegments());

  // Direct lookup: only works because (499, 10) is exactly one loaded segment.
  const direct = spkState(499, 10, 0);
  console.log('Mars rel. Sun (direct):', direct);

  // spkez() chains Mars -> Sun -> SSB automatically.
  const geometric = spkez(499, 0, 0, 'NONE');
  console.log('Mars rel. SSB (geometric):', geometric);

  // Same query, now with light-time + stellar aberration correction --
  // the apparent position/velocity an observer at the SSB would see.
  const corrected = spkez(499, 0, 0, 'LT+S');
  console.log('Mars rel. SSB (LT+S):', corrected);
} finally {
  fs.unlinkSync(tempFile);
}
