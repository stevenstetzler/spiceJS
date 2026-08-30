// Minimal usage example for body-fixed reference frames: binary PCK
// (orientation) kernels, the classic text-PCK orientation formula, and
// frame-kernel-defined (FK) frames.
//
// Like examples/spk.mjs, this repo doesn't ship real kernels (a real
// binary PCK is multi-megabyte, and naif.jpl.nasa.gov isn't reachable
// from every environment), so this demo builds everything in memory:
// a synthetic binary PCK using the same test helper spiceJS's own test
// suite uses (test/helpers/writePck.js -- see test/pck.test.js), plus
// small in-memory text kernels for the classic formula and the frame
// kernel (FK) definitions -- see test/frames.test.js for more.
//
// To use real kernels instead, skip the synthetic-file steps below and
// just call:
//   furnsh('/path/to/pck00010.tpc');          // classic IAU_* constants
//   furnsh('/path/to/moon_pa_de440_200625.bpc'); // binary PCK
//   furnsh('/path/to/moon_de440_250416.tf');     // frame kernel (MOON_PA/MOON_ME)
//   spkezr('EARTH', 'MOON', someEt, 'NONE', 'IAU_MOON');
//   spkezr('EARTH', 'MOON', someEt, 'NONE', 'MOON_PA');
//
// Run from the repo root with:
//   node examples/pck.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { furnsh, spkezr, frameId } from '../src/index.js';
import { writeSpk } from '../test/helpers/writeSpk.js';
import { writePck } from '../test/helpers/writePck.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spicejs-pck-example-'));

// --- 1. A trajectory, same shape as examples/spk.mjs: Mars (499)
//        relative to the Sun (10), Sun relative to the SSB (0). ---
const bsp = writeSpk({
  segments: [
    {
      target: 499,
      center: 10,
      frame: 1,
      type: 2,
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

// --- 2. Classic text-PCK orientation constants for Mars (499),
//        driving the built-in IAU_MARS frame (src/bodyOrientation.js).
//        Real values from NAIF's pck00010.tpc. ---
const textPck = `KPL/PCK
\\begindata
BODY499_POLE_RA   = ( 317.269202 -0.10927547 0 )
BODY499_POLE_DEC  = (  54.432516 -0.05827105 0 )
BODY499_PM        = ( 176.049863 350.891982443297 0 )
\\begintext
`;

// --- 3. A binary PCK for a made-up PCK-driven frame (DEMO_PA, id
//        91000) -- same Chebyshev record layout as SPK type 2, just
//        3 Euler angles (phi, delta, w) instead of x/y/z. ---
const bpc = writePck({
  segments: [
    {
      frame: 91000,
      refFrame: 1, // J2000
      type: 2,
      startEt: -1800,
      stopEt: 1800,
      init: -1800,
      intlen: 3600,
      records: [{ mid: 0, radius: 1800, coeffsByAxis: [[0.3, 0.01], [0.2, -0.005], [1.5, 0.4]] }],
    },
  ],
});

// --- 4. A frame kernel: DEMO_PA (class 2, PCK-driven, backed by the
//        binary PCK above) and DEMO_ME (class 4, TK, a fixed
//        arcsecond offset relative to DEMO_PA) -- same shape as the
//        real MOON_PA_DE440 / MOON_ME_DE440_ME421 pair. ---
const fk = `KPL/FK
\\begindata
FRAME_DEMO_PA          = 91000
FRAME_91000_NAME       = 'DEMO_PA'
FRAME_91000_CLASS      = 2
FRAME_91000_CLASS_ID   = 91000
FRAME_91000_CENTER     = 499

FRAME_DEMO_ME          = 91001
FRAME_91001_NAME       = 'DEMO_ME'
FRAME_91001_CLASS      = 4
FRAME_91001_CENTER     = 499

TKFRAME_91001_SPEC     = 'ANGLES'
TKFRAME_91001_RELATIVE = 'DEMO_PA'
TKFRAME_91001_ANGLES   = ( 50.0  30.0  0.5 )
TKFRAME_91001_AXES     = ( 3, 2, 1 )
TKFRAME_91001_UNITS    = 'ARCSECONDS'
\\begintext
`;

const bspPath = path.join(tmpDir, 'demo.bsp');
const pckTextPath = path.join(tmpDir, 'demo.tpc');
const bpcPath = path.join(tmpDir, 'demo.bpc');
const fkPath = path.join(tmpDir, 'demo.tf');
fs.writeFileSync(bspPath, bsp);
fs.writeFileSync(pckTextPath, textPck);
fs.writeFileSync(bpcPath, bpc);
fs.writeFileSync(fkPath, fk);

try {
  furnsh(bspPath);
  furnsh(pckTextPath);
  furnsh(bpcPath);
  furnsh(fkPath);

  console.log('IAU_MARS frame ID:', frameId('IAU_MARS')); // built-in, classic formula
  console.log('DEMO_PA frame ID:', frameId('DEMO_PA')); // FK-defined, binary-PCK-driven
  console.log('DEMO_ME frame ID:', frameId('DEMO_ME')); // FK-defined, fixed-offset (TK)

  // Mars relative to the Sun, in the classic IAU_MARS body-fixed frame.
  const inIauMars = spkezr('MARS', 'SUN', 0, 'NONE', 'IAU_MARS');
  console.log('Mars rel. Sun (IAU_MARS):', inIauMars);

  // The same state, in the binary-PCK-driven DEMO_PA frame, and its
  // fixed-offset relative DEMO_ME frame -- both time-varying, so
  // (unlike the 21 inertial frames) the velocity here includes an
  // angular-velocity contribution, not just a rotated copy of vx/vy/vz.
  console.log('Mars rel. Sun (DEMO_PA):', spkezr('MARS', 'SUN', 0, 'NONE', 'DEMO_PA'));
  console.log('Mars rel. Sun (DEMO_ME):', spkezr('MARS', 'SUN', 0, 'NONE', 'DEMO_ME'));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
