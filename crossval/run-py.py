#!/usr/bin/env python3
"""Runs every case in cases.json through spiceypy (real CSPICE) and
writes results-py.json, in the same shape run-js.mjs writes
results-js.json."""
import json
import os

import spiceypy as spice

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")

spice.furnsh(os.path.join(HERE, "..", "kernels", "naif0012.tls"))
spice.furnsh(os.path.join(HERE, "pck00010.tpc"))
spice.furnsh(os.path.join(HERE, "pck00011.tpc"))
spice.furnsh(os.path.join(HERE, "gm_de440.tpc"))
spice.furnsh(os.path.join(HERE, "dss17.bsp"))
spice.furnsh(os.path.join(FIXTURES, "kernel.bsp"))
spice.furnsh(os.path.join(FIXTURES, "sclk.tsc"))
spice.furnsh(os.path.join(FIXTURES, "ck.bc"))

with open(os.path.join(FIXTURES, "cases.json")) as f:
    cases = json.load(f)

sc = cases.get("sc")

str2et_results = []
for time_string in cases["str2etCases"]:
    try:
        str2et_results.append({"input": time_string, "et": spice.str2et(time_string)})
    except Exception as err:  # noqa: BLE001 -- mirror run-js.mjs's catch-all
        str2et_results.append({"input": time_string, "error": str(err)})

tai_results = []
for et in cases.get("taiCases", []):
    tai = spice.unitim(et, "ET", "TAI")
    tai_results.append({"input": et, "tai": tai, "roundTripEt": spice.unitim(tai, "TAI", "ET")})

# Every synthetic kernel.bsp segment is natively frame 1 (J2000), so a
# spiceJS case with no `ref` (native frame, unrotated) is numerically
# identical to explicitly requesting J2000 -- default to that here.
spkez_results = []
for c in cases["spkezCases"]:
    try:
        ref = c.get("ref") or "J2000"
        state, lt = spice.spkez(c["target"], c["et"], ref, c["abcorr"], c["center"])
        spkez_results.append({"input": c, "state": [float(x) for x in state], "lightTime": float(lt)})
    except Exception as err:  # noqa: BLE001
        spkez_results.append({"input": c, "error": str(err)})

spkezr_results = []
for c in cases.get("spkezrCases", []):
    try:
        ref = c.get("ref") or "J2000"
        state, lt = spice.spkezr(c["target"], c["et"], ref, c["abcorr"], c["observer"])
        spkezr_results.append({"input": c, "state": [float(x) for x in state], "lightTime": float(lt)})
    except Exception as err:  # noqa: BLE001
        spkezr_results.append({"input": c, "error": str(err)})

# spkState() (spiceJS) is a direct, non-chaining lookup -- spkgeo (real
# CSPICE) is its closest equivalent: a single geometric state, no
# aberration correction, and (for these specific cases) no chaining
# needed either, since the requested observer already *is* the
# target's segment-native center. See gen-cases.mjs's comment on
# spkStateCases for why dss17.bsp is tested this way rather than via
# spkez/spkezr (which always chain the target all the way to the SSB).
spk_state_results = []
for c in cases.get("spkStateCases", []):
    try:
        state, lt = spice.spkgeo(c["target"], c["et"], c["ref"], c["center"])
        spk_state_results.append({"input": c, "state": [float(x) for x in state]})
    except Exception as err:  # noqa: BLE001
        spk_state_results.append({"input": c, "error": str(err)})

body_value_results = []
for c in cases.get("bodyValueCases", []):
    try:
        dim, values = spice.bodvrd(str(c["body"]), c["item"], 10)
        body_value_results.append({"input": c, "values": [float(x) for x in values[:dim]]})
    except Exception as err:  # noqa: BLE001
        body_value_results.append({"input": c, "error": str(err)})

prop2b_results = []
for c in cases.get("prop2bCases", []):
    try:
        state = spice.prop2b(c["gm"], c["pvinit"], c["dt"])
        prop2b_results.append({"input": c, "state": [float(x) for x in state]})
    except Exception as err:  # noqa: BLE001
        prop2b_results.append({"input": c, "error": str(err)})

sc_encode_results = []
for clock_string in cases.get("scEncodeCases", []):
    try:
        sc_encode_results.append({"input": clock_string, "ticks": float(spice.scencd(sc, clock_string))})
    except Exception as err:  # noqa: BLE001
        sc_encode_results.append({"input": clock_string, "error": str(err)})

sc_decode_results = []
for ticks in cases.get("scDecodeCases", []):
    try:
        sc_decode_results.append({"input": ticks, "clockString": spice.scdecd(sc, ticks, 40)})
    except Exception as err:  # noqa: BLE001
        sc_decode_results.append({"input": ticks, "error": str(err)})

sclk_to_et_results = []
for ticks in cases.get("sclkToEtCases", []):
    try:
        sclk_to_et_results.append({"input": ticks, "et": float(spice.sct2e(sc, ticks))})
    except Exception as err:  # noqa: BLE001
        sclk_to_et_results.append({"input": ticks, "error": str(err)})

et_to_sclk_results = []
for et in cases.get("etToSclkCases", []):
    try:
        et_to_sclk_results.append({"input": et, "ticks": float(spice.sce2c(sc, et))})
    except Exception as err:  # noqa: BLE001
        et_to_sclk_results.append({"input": et, "error": str(err)})

# spiceypy's ckgp/ckgpav raise (rather than returning a `found` flag)
# when no pointing satisfies the request -- caught the same way any
# other genuine error is, since compare.mjs's own ckCases comparator
# treats "spiceJS found:false" as equivalent to "spiceypy raised",
# same convention every other case list already uses for "both sides
# agree nothing was found."
ck_results = []
for c in cases.get("ckCases", []):
    try:
        if c["needAv"]:
            cmat, av, clkout = spice.ckgpav(c["inst"], c["sclkdp"], c["tol"], c["ref"])
            av = [float(x) for x in av]
        else:
            cmat, clkout = spice.ckgp(c["inst"], c["sclkdp"], c["tol"], c["ref"])
            av = None
        ck_results.append({
            "input": c,
            "found": True,
            "cmat": [[float(x) for x in row] for row in cmat],
            "av": av,
            "clkout": float(clkout),
        })
    except Exception as err:  # noqa: BLE001
        ck_results.append({"input": c, "error": str(err)})

with open(os.path.join(FIXTURES, "results-py.json"), "w") as f:
    json.dump(
        {
            "str2etResults": str2et_results,
            "taiResults": tai_results,
            "spkezResults": spkez_results,
            "spkezrResults": spkezr_results,
            "spkStateResults": spk_state_results,
            "bodyValueResults": body_value_results,
            "prop2bResults": prop2b_results,
            "scEncodeResults": sc_encode_results,
            "scDecodeResults": sc_decode_results,
            "sclkToEtResults": sclk_to_et_results,
            "etToSclkResults": et_to_sclk_results,
            "ckResults": ck_results,
        },
        f,
        indent=2,
    )

print(
    f"spiceypy: {len(str2et_results)} str2et cases, {len(tai_results)} tai cases, {len(spkez_results)} spkez cases, "
    f"{len(spkezr_results)} spkezr cases, {len(spk_state_results)} spkState cases, "
    f"{len(body_value_results)} bodyValues cases, {len(prop2b_results)} prop2b cases, "
    f"{len(sc_encode_results) + len(sc_decode_results) + len(sclk_to_et_results) + len(et_to_sclk_results)} sclk cases, "
    f"{len(ck_results)} ck cases "
    f"-> results-py.json (CSPICE {spice.tkvrsn('TOOLKIT')})"
)
