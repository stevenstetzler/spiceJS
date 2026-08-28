#!/usr/bin/env python3
"""Builds crossval/fixtures/ck.bc and crossval/fixtures/sclk.tsc using
spiceypy's own real CK/SCLK writers (ckw01/ckw02/ckw03, and a plain
KPL/SCLK text file) -- unlike every other crossval fixture (built by
spiceJS's own test/helpers/writeSpk.js), this one is written by real
CSPICE itself, so it validates ck.js's *reader* against a genuinely
CSPICE-authored file, not just against spiceJS's own understanding of
the format encoded a second time in a hand-written test helper.

This also specifically includes segments with > 100 records (type 1's
150, type 2's 120, type 3's 230 across two intervals with a real
tolerance-testing gap between them) -- real CK files of this size carry
an on-disk "directory" spiceJS's own reader deliberately never parses
(see ck.js's own module doc comment for why that's a safe
simplification, not an approximation); this is what actually proves
that claim against a real directory-bearing file, not just spiceJS's
own directory-free synthetic fixtures in test/ck.test.js.

Run once, before run-js.mjs/run-py.py (see package.json's `crossval`
script) -- both of those furnsh the files this writes.
"""
import os

import numpy as np
import spiceypy as spice

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
os.makedirs(FIXTURES, exist_ok=True)

SC = -900  # test spacecraft clock ID
INST = -900000  # test instrument ID -- floor(-900000/1000) == -900 == SC, so no CK_<inst>_SCLK variable is needed (ck.js's own documented ckmeta_ fallback)

SCLK_PATH = os.path.join(FIXTURES, "sclk.tsc")
CK_PATH = os.path.join(FIXTURES, "ck.bc")

# A simple, single-partition, single-coefficient-breakpoint clock: 256
# ticks per "RIM" unit, and (via rate=1) 1 TDB second per RIM unit --
# so et = ticks / 256 exactly. The *string*/partition side of SCLK
# (multiple partitions, multi-breakpoint coefficients) is already
# thoroughly crossvalidated on its own via a synthetic text kernel in
# sclkCases below -- this fixture only needs to be internally
# consistent enough to drive ckgp/ckgpav requests.
# Real SCLK variable names use |SC|, not SC itself -- confirmed
# directly against real CSPICE (see src/sclk.js's own doc comment).
SCID = abs(SC)
sclk_text = f"""KPL/SCLK

\\begindata

SCLK_DATA_TYPE_{SCID} = ( 1 )
SCLK01_TIME_SYSTEM_{SCID} = ( 1 )
SCLK01_N_FIELDS_{SCID} = ( 2 )
SCLK01_MODULI_{SCID} = ( 10000000, 256 )
SCLK01_OFFSETS_{SCID} = ( 0, 0 )
SCLK01_OUTPUT_DELIM_{SCID} = ( 2 )
SCLK_PARTITION_START_{SCID} = ( 0 )
SCLK_PARTITION_END_{SCID} = ( 2559999999 )
SCLK01_COEFFICIENTS_{SCID} = ( 0, 0, 1 )

\\begintext
"""
with open(SCLK_PATH, "w") as f:
    f.write(sclk_text)

spice.furnsh(os.path.join(HERE, "..", "kernels", "naif0012.tls"))
spice.furnsh(SCLK_PATH)

if os.path.exists(CK_PATH):
    os.remove(CK_PATH)
handle = spice.ckopn(CK_PATH, "spiceJS synthetic crossval CK", 0)


def quat_about_z(theta):
    return [np.cos(theta / 2), 0.0, 0.0, np.sin(theta / 2)]


# --- Type 1: 150 discrete instances, steadily rotating about +Z. ---
n1 = 150
t1_sclk = np.array([i * 10000.0 for i in range(n1)])
t1_quats = np.array([quat_about_z(i * 0.01) for i in range(n1)])
t1_avvs = np.array([[0.0, 0.0, 0.001] for _ in range(n1)])
spice.ckw01(handle, t1_sclk[0], t1_sclk[-1], INST, "J2000", True, "type1", n1, t1_sclk, t1_quats, t1_avvs)

# --- Type 2: 120 contiguous fixed-rate intervals. ---
n2 = 120
base2 = 2_000_000.0
t2_start = np.array([base2 + i * 10000.0 for i in range(n2)])
t2_stop = t2_start + 9999.0
t2_quats = np.array([[1.0, 0.0, 0.0, 0.0] for _ in range(n2)])
t2_avvs = np.array([[0.0, 0.0, 0.001] for _ in range(n2)])
t2_rates = np.array([1.0 for _ in range(n2)])
spice.ckw02(handle, t2_start[0], t2_stop[-1], INST, "J2000", "type2", n2, t2_start, t2_stop, t2_quats, t2_avvs, t2_rates)

# --- Type 3: two continuous chunks (100 + 130 records) with a real
# gap between sclkdp 5_000_990 and 5_002_000 -- exercises both the
# > 100-record directory and the gap/tolerance fallback path.
base3 = 5_000_000.0
chunk_a = [base3 + i * 10.0 for i in range(100)]  # 5,000,000 .. 5,000,990
chunk_b = [5_002_000.0 + i * 10.0 for i in range(130)]  # 5,002,000 .. 5,003,290
t3_sclk = np.array(chunk_a + chunk_b)
t3_quats = np.array([quat_about_z(i * 0.005) for i in range(len(t3_sclk))])
t3_avvs = np.array([[0.0, 0.0, 0.0005] for _ in range(len(t3_sclk))])
n3 = len(t3_sclk)
starts3 = np.array([chunk_a[0], chunk_b[0]])
spice.ckw03(handle, t3_sclk[0], t3_sclk[-1], INST, "J2000", True, "type3", n3, t3_sclk, t3_quats, t3_avvs, len(starts3), starts3)

spice.ckcls(handle)
spice.kclear()

print(f"Wrote {SCLK_PATH} and {CK_PATH} (SC={SC}, INST={INST}, types 1/2/3: {n1}/{n2}/{n3} records).")
