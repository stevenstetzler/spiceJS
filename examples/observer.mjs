// Position of a ground observer (lat/lon/alt on the Earth ellipsoid)
// relative to the solar system barycenter (SSB), in J2000.
//
// Needs, via furnsh(): an SPK with Earth (e.g. de440s.bsp), a text PCK
// with BODY399_RADII (pck00011.tpc), and an LSK (naif0012.tls).
// For high accuracy also load a binary Earth PCK + its FK:
//   earth_latest_high_prec.bpc, earth_assoc_itrf93.tf   and use 'ITRF93'.
// Without them, the built-in 'IAU_EARTH' frame still works but ignores
// nutation / polar motion / UT1 (errors of order km on the surface).

import { furnsh, str2et, spkezr, bodyValues, frameId } from '../src/index.js';
import { frameRotationMatrix } from '../src/frames.js'; // not re-exported from index.js yet

const DEG = Math.PI / 180;

// SPICE georec(): geodetic lon/lat/alt -> body-fixed rectangular (km)
function georec(lonRad, latRad, altKm, equatorialRadius, flattening) {
  const e2 = flattening * (2 - flattening);
  const sinLat = Math.sin(latRad);
  const n = equatorialRadius / Math.sqrt(1 - e2 * sinLat * sinLat);
  return [
    (n + altKm) * Math.cos(latRad) * Math.cos(lonRad),
    (n + altKm) * Math.cos(latRad) * Math.sin(lonRad),
    (n * (1 - e2) + altKm) * sinLat,
  ];
}

/** Observer position/velocity relative to the SSB in J2000 (km, km/s). */
export function observerWrtSsb({ lonDeg, latDeg, altKm = 0 }, et, bodyFixed = 'ITRF93') {
  // 1. Earth's centre relative to SSB (spkez chains 399 -> 3 -> 0 automatically)
  const earth = spkezr('EARTH', 'SSB', et, 'NONE', 'J2000');

  // 2. Ellipsoid shape from the text PCK
  const [a, , c] = bodyValues('EARTH', 'RADII');
  const f = (a - c) / a;

  // 3. Observer in the Earth-fixed frame, relative to Earth's centre
  const rFixed = georec(lonDeg * DEG, latDeg * DEG, altKm, a, f);

  // 4. Rotate Earth-fixed -> J2000. dmatrix gives velocity from Earth's spin.
  const { matrix: R, dmatrix: dR } = frameRotationMatrix(frameId(bodyFixed), frameId('J2000'), et);
  const mv = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const rJ = mv(R, rFixed);
  const vJ = mv(dR, rFixed); // observer is fixed to the ground

  // 5. SSB -> Earth centre -> observer
  return {
    position: earth.position.map((x, i) => x + rJ[i]),
    velocity: earth.velocity.map((x, i) => x + vJ[i]),
  };
}

// --- demo (only runs when executed directly) ---
if (import.meta.url === `file://${process.argv[1]}`) {
  furnsh('kernels/naif0012.tls');
  furnsh('kernels/pck00011.tpc');
  furnsh('/path/to/de440s.bsp');
  // furnsh('/path/to/earth_latest_high_prec.bpc'); furnsh('/path/to/earth_assoc_itrf93.tf');

  const et = str2et('2026-10-07T00:00:00');
  // Mauna Kea summit
  console.log(observerWrtSsb({ lonDeg: -155.4681, latDeg: 19.8207, altKm: 4.205 }, et, 'IAU_EARTH'));
}
