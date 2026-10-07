#!/usr/bin/env python3
"""Cross-check ground-observer SSB states from SPICE against JPL Horizons,
for every MPC observatory code.  Target: Juno (-61); epoch: 2026-10-07T00:00 UTC.

Horizons side (astroquery.jplhorizons), per site:
    A = target wrt SSB                      (location '500@0')
    B = target wrt the site                 (location = geodetic lon/lat/elevation)
    observer wrt SSB = A - B
SPICE side (spiceypy): Earth wrt SSB (DE440s) + ITRF93 -> J2000 rotation of
the Earth-fixed site vector (SPICE georec).  Both sides use the WGS84 ellipsoid
so the ellipsoid itself cannot contribute to the difference.

Site coordinates: by default derived from the MPC parallax constants in
ObsCodesF.html (rho*cos(phi'), rho*sin(phi') in equatorial Earth radii), which
fixes longitude, geodetic latitude and a height.  Pass --sites-csv
(code,lon_deg_east,lat_deg,alt_m) to override with e.g. Project Pluto values.

Usage:
    python3 examples/horizons_obscodes_check.py --mpc ObsCodesF.html
    python3 examples/horizons_obscodes_check.py --mpc ObsCodesF.html --sites-csv sites.csv
"""
import argparse
import csv
import html
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import spiceypy as sp
from astroquery.jplhorizons import Horizons

EPOCH_UTC = "2026-10-07T00:00:00"
TARGET = "-61"  # Juno
CACHE = Path(__file__).resolve().parent.parent / "kernels" / "cache"
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
KERNELS = {
    "naif0012.tls": f"{NAIF}/lsk/naif0012.tls",
    "pck00011.tpc": f"{NAIF}/pck/pck00011.tpc",
    "de440s.bsp": f"{NAIF}/spk/planets/de440s.bsp",
    "earth_latest_high_prec.bpc": f"{NAIF}/pck/earth_latest_high_prec.bpc",
    "earth_assoc_itrf93.tf": f"{NAIF}/fk/planets/earth_assoc_itrf93.tf",
}
# WGS84, what Horizons uses for SITE_COORD (km)
A_KM = 6378.137
F = 1 / 298.257223563
AU_KM = 149597870.7


def load_kernels():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, url in KERNELS.items():
        dest = CACHE / name
        if not dest.exists():
            print(f"downloading {name} ...", file=sys.stderr)
            urllib.request.urlretrieve(url, dest)
        sp.furnsh(str(dest))


def read_text(src):
    if re.match(r"https?://", src):
        return urllib.request.urlopen(src, timeout=60).read().decode("utf-8", "replace")
    return Path(src).read_text(encoding="utf-8", errors="replace")


ROW = re.compile(r"^(\w{3})\s+(-?\d+(?:\.\d*)?)\s+(\d+(?:\.\d*)?)\s+([+-]?\d+(?:\.\d*)?)\s+(.*)$")


def parse_mpc(text):
    """ObsCodesF rows: code, east longitude (deg), rho*cos(phi'), rho*sin(phi'), name.
    Works on the raw .html (a <pre> block) or a plain-text copy.  Rows without
    parallax constants (spacecraft, roving observers) don't match and are skipped."""
    sites = {}
    for line in html.unescape(re.sub(r"<[^>]+>", "", text)).splitlines():
        m = ROW.match(line.rstrip())
        if not m:
            continue
        code, lon, c, s_, name = m.groups()
        c, s_ = float(c), float(s_)
        if c == 0 and s_ == 0:
            continue
        sites[code] = {"code": code, "lon": float(lon) % 360.0, "cos": c, "sin": s_, "name": name.strip()}
    return sites


def geodetic_from_mpc(site):
    """MPC parallax constants -> (lon_deg E, lat_deg geodetic, alt_km) on WGS84."""
    lam = np.radians(site["lon"])
    rec = A_KM * np.array([site["cos"] * np.cos(lam), site["cos"] * np.sin(lam), site["sin"]])
    lon, lat, alt = sp.recgeo(rec, A_KM, F)
    return np.degrees(lon), np.degrees(lat), alt


def spice_observer(lon_deg, lat_deg, alt_km, et):
    """Observer (position km, velocity km/s) wrt SSB in J2000, via SPICE."""
    earth, _ = sp.spkezr("399", et, "J2000", "NONE", "0")
    r_fixed = sp.georec(np.radians(lon_deg), np.radians(lat_deg), alt_km, A_KM, F)
    xf = sp.sxform("ITRF93", "J2000", et)  # 6x6 state transform
    state = xf @ np.concatenate([r_fixed, np.zeros(3)])  # site fixed to the ground
    return np.array(earth) + state


def horizons_state(location, jd_tdb, retries=4):
    for attempt in range(retries):
        try:
            obj = Horizons(id=TARGET, id_type=None, location=location, epochs=[jd_tdb])
            t = obj.vectors(refplane="earth", aberrations="geometric", cache=False)
            row = t[0]
            pos = np.array([row["x"], row["y"], row["z"]], dtype=float) * AU_KM
            vel = np.array([row["vx"], row["vy"], row["vz"]], dtype=float) * AU_KM / 86400.0
            return np.concatenate([pos, vel])
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def main():
    global TARGET
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mpc", required=True, help="ObsCodesF.html (path or URL)")
    ap.add_argument("--sites-csv", help="code,lon_deg_east,lat_deg,alt_m overriding MPC-derived coordinates")
    ap.add_argument("--codes", help="comma-separated subset of codes")
    ap.add_argument("--target", default=TARGET, help="Horizons COMMAND (default Juno, -61)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--out", default="horizons_obscodes_check.csv")
    args = ap.parse_args()

    TARGET = args.target
    load_kernels()
    et = sp.str2et(EPOCH_UTC)  # UTC by default
    jd_tdb = 2451545.0 + et / 86400.0
    print(f"epoch {EPOCH_UTC} UTC  ET {et:.6f}  JD(TDB) {jd_tdb:.9f}  target {TARGET}")

    sites = parse_mpc(read_text(args.mpc))
    override = {}
    if args.sites_csv:
        with open(args.sites_csv) as fh:
            for r in csv.reader(fh):
                if r and not r[0].startswith("#"):
                    override[r[0].strip()] = (float(r[1]), float(r[2]), float(r[3]) / 1000.0)
    codes = args.codes.split(",") if args.codes else sorted(sites)
    print(f"{len(codes)} sites ({len(override)} with coordinate overrides)")

    state_a = horizons_state("500@0", jd_tdb)  # Juno wrt SSB, once

    # Geometry (SPICE) is cheap and CSPICE is not thread-safe: do it serially.
    # Only the slow network queries run in the thread pool.
    geo = {}
    for code in codes:
        geo[code] = override.get(code) or geodetic_from_mpc(sites[code])

    def fetch(code):
        lon, lat, alt = geo[code]
        lon_h = lon - 360.0 if lon > 180 else lon
        try:
            return horizons_state({"lon": lon_h, "lat": lat, "elevation": alt}, jd_tdb)
        except Exception as exc:  # noqa: BLE001
            return exc

    with ThreadPoolExecutor(args.workers) as ex:
        topo = list(ex.map(fetch, codes))

    results = []
    for code, b in zip(codes, topo):
        s = sites[code]
        if isinstance(b, Exception):
            results.append({"code": code, "name": s["name"], "error": str(b)[:120]})
            continue
        lon, lat, alt = geo[code]
        d = spice_observer(lon, lat, alt, et) - (state_a - b)
        results.append({
            "code": code, "name": s["name"], "lon": lon, "lat": lat, "alt_m": alt * 1000,
            "dpos_m": np.linalg.norm(d[:3]) * 1000, "dvel_mm_s": np.linalg.norm(d[3:]) * 1e6,
            "dx_m": d[0] * 1000, "dy_m": d[1] * 1000, "dz_m": d[2] * 1000,
        })

    ok = [r for r in results if "error" not in r]
    bad = [r for r in results if "error" in r]
    with open(args.out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["code", "name", "lon", "lat", "alt_m", "dpos_m", "dvel_mm_s", "dx_m", "dy_m", "dz_m", "error"])
        w.writeheader()
        w.writerows(results)

    d = np.array([r["dpos_m"] for r in ok])
    print(f"\n{len(ok)} compared, {len(bad)} failed -> {args.out}")
    if len(d):
        print(f"|dpos| m: median {np.median(d):.1f}  mean {d.mean():.1f}  p95 {np.percentile(d, 95):.1f}  max {d.max():.1f}")
        spread = d.max() - d.min()
        print(f"spread across sites (max-min): {spread:.1f} m   <- site-dependent error; the common offset is a Horizons-Juno effect")
        dv = np.array([[r["dx_m"], r["dy_m"], r["dz_m"]] for r in ok])
        common = np.median(dv, axis=0)
        resid = np.linalg.norm(dv - common, axis=1)
        print(f"common offset vector (median, m): {common.round(2)}  |.| = {np.linalg.norm(common):.1f} m")
        print(f"|dpos - common| m: median {np.median(resid):.2f}  p95 {np.percentile(resid, 95):.2f}  max {resid.max():.2f}")
        print("worst 10:")
        for r in sorted(ok, key=lambda r: -r["dpos_m"])[:10]:
            print(f"  {r['code']} {r['dpos_m']:9.1f} m  {r['dvel_mm_s']:8.2f} mm/s  {r['name'][:40]}")
    for r in bad[:10]:
        print(f"  FAILED {r['code']}: {r['error']}")


if __name__ == "__main__":
    main()
