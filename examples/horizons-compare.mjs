// Cross-check spiceJS's ground-observer geometry against JPL Horizons.
//
// Horizons gives us, for a target (default Juno, -61) at one epoch:
//   A. target relative to the SSB          (CENTER = '500@0')
//   B. target relative to a ground site    (CENTER = 'coord@399', SITE_COORD)
// so the observer's SSB-relative state is  A - B  (observer = target - rel).
// We compare that to observerWrtSsb() from examples/observer.mjs, which
// uses spiceJS (DE440s + Earth orientation) -- no Horizons data involved.
//
// Usage:  node examples/horizons-compare.mjs [UTC-time] [target]
//   e.g.  node examples/horizons-compare.mjs 2026-10-07T00:00:00 -61
// Kernels (de440s, earth_latest_high_prec.bpc, earth_assoc_itrf93.tf) are
// downloaded once into kernels/cache/ (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import { furnsh, str2et, spkezr, bodyValues } from '../src/index.js';
import { observerWrtSsb } from './observer.mjs';

const NAIF = 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels';
const CACHE = new URL('../kernels/cache/', import.meta.url).pathname;
const KERNELS = [
  ['naif0012.tls', null],
  ['pck00011.tpc', null],
  ['de440s.bsp', `${NAIF}/spk/planets/de440s.bsp`],
  ['earth_latest_high_prec.bpc', `${NAIF}/pck/earth_latest_high_prec.bpc`],
  ['earth_assoc_itrf93.tf', `${NAIF}/fk/planets/earth_assoc_itrf93.tf`],
];

// Milan = MPC code 027. Geodetic position from the task; MPC parallax
// constants (rho cos phi', rho sin phi' in Earth equatorial radii) for a
// secondary check.
const SITE = { name: 'Milan (027)', lonDeg: 9.1885, latDeg: 45.4647, altKm: 0.12 };
const MPC_027 = { lonDeg: 9.1912, cos: 0.70254, sin: 0.70929 };

async function ensureKernels() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const [name, url] of KERNELS) {
    const dest = path.join(CACHE, name);
    if (fs.existsSync(dest)) continue;
    if (!url) { fs.copyFileSync(new URL(`../kernels/${name}`, import.meta.url), dest); continue; }
    console.error(`downloading ${name} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  for (const [name] of KERNELS) furnsh(path.join(CACHE, name));
}

/** One Horizons VECTORS query -> { position: km[3], velocity: km/s[3] } in ICRF. */
async function horizonsVector(command, center, jdTdb, siteCoord) {
  const q = new URLSearchParams({
    format: 'text',
    COMMAND: `'${command}'`,
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: `'${center}'`,
    OUT_UNITS: 'KM-S',
    CSV_FORMAT: 'YES',
    REF_PLANE: 'FRAME',
    REF_SYSTEM: 'ICRF',
    VEC_TABLE: '2',
    VEC_CORR: 'NONE',
    OBJ_DATA: 'NO',
    TIME_TYPE: 'TDB',
    TLIST: String(jdTdb),
  });
  if (siteCoord) {
    q.set('COORD_TYPE', 'GEODETIC');
    q.set('SITE_COORD', `'${siteCoord}'`); // E-lon deg, lat deg, alt km
  }
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${q}`);
  const text = await res.text();
  const m = text.match(/\$\$SOE\s*\n([^\n]+)\n\s*\$\$EOE/);
  if (!m) throw new Error(`Horizons gave no data:\n${text.slice(0, 1500)}`);
  const v = m[1].split(',').slice(2, 8).map(Number);
  return { position: v.slice(0, 3), velocity: v.slice(3, 6) };
}

const sub = (a, b) => a.map((x, i) => x - b[i]);
const norm = (a) => Math.hypot(...a);
const fmt = (a) => a.map((x) => x.toFixed(6).padStart(16)).join(' ');

const utc = process.argv[2] ?? '2026-10-07T00:00:00';
const target = process.argv[3] ?? '-61';

await ensureKernels();
const et = str2et(utc);
const jdTdb = 2451545 + et / 86400;
console.log(`UTC ${utc}  ET ${et.toFixed(6)}  JD(TDB) ${jdTdb.toFixed(9)}  target ${target}`);

// --- Horizons side ---
const siteCoord = `${SITE.lonDeg},${SITE.latDeg},${SITE.altKm}`;
const [tSsb, tTopo] = await Promise.all([
  horizonsVector(target, '500@0', jdTdb),
  horizonsVector(target, 'coord@399', jdTdb, siteCoord),
]);
const horizons = {
  position: sub(tSsb.position, tTopo.position),
  velocity: sub(tSsb.velocity, tTopo.velocity),
};

// --- spiceJS side ---
const mine = {
  itrf93: observerWrtSsb(SITE, et, 'ITRF93'),
  iau: observerWrtSsb(SITE, et, 'IAU_EARTH'),
};
// MPC parallax constants -> Earth-fixed vector (km), then same rotation path.
const [a] = bodyValues('EARTH', 'RADII');
const lam = (MPC_027.lonDeg * Math.PI) / 180;
const rMpc = [a * MPC_027.cos * Math.cos(lam), a * MPC_027.cos * Math.sin(lam), a * MPC_027.sin];
const { frameRotationMatrix } = await import('../src/frames.js');
const { frameId } = await import('../src/index.js');
const { matrix: R, dmatrix: dR } = frameRotationMatrix(frameId('ITRF93'), frameId('J2000'), et);
const mv = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const earth = spkezr('EARTH', 'SSB', et, 'NONE', 'J2000');
mine.mpc = {
  position: earth.position.map((x, i) => x + mv(R, rMpc)[i]),
  velocity: earth.velocity.map((x, i) => x + mv(dR, rMpc)[i]),
};

console.log(`\nObserver ${SITE.name} wrt SSB (ICRF/J2000), km and km/s`);
console.log('Horizons (A-B)   pos', fmt(horizons.position), '\n                 vel', fmt(horizons.velocity));
for (const [label, s] of [
  ['spiceJS ITRF93 (lat/lon/alt)', mine.itrf93],
  ['spiceJS IAU_EARTH          ', mine.iau],
  ['spiceJS ITRF93 (MPC consts)', mine.mpc],
]) {
  const dp = sub(s.position, horizons.position);
  const dv = sub(s.velocity, horizons.velocity);
  console.log(`\n${label}\n  pos`, fmt(s.position), '\n  vel', fmt(s.velocity));
  console.log(`  d_pos ${fmt(dp)}  |d_pos| = ${(norm(dp) * 1000).toFixed(3)} m`);
  console.log(`  d_vel |d_vel| = ${(norm(dv) * 1e6).toFixed(3)} mm/s`);
}
