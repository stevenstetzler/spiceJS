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
//   spkState(499, 0, someEt);   // e.g. Mars (499) relative to the SSB (0)
//
// Run from the repo root with:
//   node examples/spk.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { furnsh, spkState, spkSegments } from '../src/index.js';
import { writeSpk } from '../test/helpers/writeSpk.js';

// A body (arbitrary ID 499, "Mars") moving in a straight line at
// 1 km/s in X relative to its center (ID 10, "the Sun"), for the
// hour around J2000 (ET seconds past J2000: -1800 to 1800).
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
  ],
});

const tempFile = path.join(os.tmpdir(), `spicejs-example-${process.pid}.bsp`);
fs.writeFileSync(tempFile, buffer);

try {
  furnsh(tempFile);

  console.log('Loaded segments:', spkSegments());

  const { position, velocity } = spkState(499, 10, 0);
  console.log('Position (km):', position);
  console.log('Velocity (km/s):', velocity);
} finally {
  fs.unlinkSync(tempFile);
}
