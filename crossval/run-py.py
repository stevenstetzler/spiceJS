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

with open(os.path.join(FIXTURES, "cases.json")) as f:
    cases = json.load(f)

str2et_results = []
for time_string in cases["str2etCases"]:
    try:
        str2et_results.append({"input": time_string, "et": spice.str2et(time_string)})
    except Exception as err:  # noqa: BLE001 -- mirror run-js.mjs's catch-all
        str2et_results.append({"input": time_string, "error": str(err)})

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

with open(os.path.join(FIXTURES, "results-py.json"), "w") as f:
    json.dump(
        {
            "str2etResults": str2et_results,
            "spkezResults": spkez_results,
            "spkezrResults": spkezr_results,
            "spkStateResults": spk_state_results,
            "bodyValueResults": body_value_results,
            "prop2bResults": prop2b_results,
        },
        f,
        indent=2,
    )

print(
    f"spiceypy: {len(str2et_results)} str2et cases, {len(spkez_results)} spkez cases, "
    f"{len(spkezr_results)} spkezr cases, {len(spk_state_results)} spkState cases, "
    f"{len(body_value_results)} bodyValues cases, {len(prop2b_results)} prop2b cases "
    f"-> results-py.json (CSPICE {spice.tkvrsn('TOOLKIT')})"
)
