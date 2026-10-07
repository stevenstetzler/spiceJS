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

Site coordinates (longitude E, geodetic latitude, altitude) come from the
Project Pluto observatory-code list (https://projectpluto.com/obsc.htm), saved
verbatim in examples/data/projectpluto_obsc.txt.  Rows with zero parallax
constants (spacecraft, roving observers, geocentric) have no ground position
and are skipped.

Usage:
    python3 examples/horizons_obscodes_check.py
    python3 examples/horizons_obscodes_check.py --codes 027,500,F51
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


ROW = re.compile(
    r"^(\w{3})\s+(-?\d+(?:\.\d*)?)\s+([+-]\d+(?:\.\d*)?)\s+(-?\d+(?:\.\d*)?)"
    r"\s+(\d+(?:\.\d*)?)\s+([+-]\d+(?:\.\d*)?)\s+(.*)$"
)
DEFAULT_SITES = Path(__file__).resolve().parent / "data" / "projectpluto_obsc.txt"


def parse_pluto(text):
    """Rows: code, E longitude (deg), geodetic latitude (deg), altitude (m),
    rho*cos(phi'), rho*sin(phi'), then 'region  name'.  Returns
    {code: {lon, lat, alt_km, name}} for ground sites only."""
    sites = {}
    for line in text.splitlines():
        m = ROW.match(line.rstrip())
        if not m:
            continue
        code, lon, lat, alt, c, s_, rest = m.groups()
        if float(c) == 0 and float(s_) == 0:
            continue
        sites[code] = {
            "code": code, "lon": float(lon) % 360.0, "lat": float(lat),
            "alt_km": float(alt) / 1000.0, "name": rest.strip(),
        }
    return sites


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
    ap.add_argument("--sites", default=str(DEFAULT_SITES), help="Project Pluto obsc list (path or URL)")
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

    sites = parse_pluto(read_text(args.sites))
    codes = args.codes.split(",") if args.codes else sorted(sites)
    print(f"{len(codes)} ground sites")

    state_a = horizons_state("500@0", jd_tdb)  # Juno wrt SSB, once

    # Geometry (SPICE) is cheap and CSPICE is not thread-safe: do it serially.
    # Only the slow network queries run in the thread pool.
    geo = {c: (sites[c]["lon"], sites[c]["lat"], sites[c]["alt_km"]) for c in codes}

    # Many stations share identical coordinates: query each distinct one once.
    unique = sorted({geo[c] for c in codes})
    print(f"{len(unique)} distinct coordinates -> Horizons queries")

    def fetch(key):
        lon, lat, alt = key
        lon_h = lon - 360.0 if lon > 180 else lon
        try:
            return horizons_state({"lon": lon_h, "lat": lat, "elevation": alt}, jd_tdb)
        except Exception as exc:  # noqa: BLE001
            return exc

    with ThreadPoolExecutor(args.workers) as ex:
        fetched = {}
        for i, (key, val) in enumerate(zip(unique, ex.map(fetch, unique)), 1):
            fetched[key] = val
            if i % 200 == 0:
                print(f"  {i}/{len(unique)}", file=sys.stderr, flush=True)
    topo = [fetched[geo[c]] for c in codes]

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
