#!/usr/bin/env python3
"""Computes real-CSPICE (spiceypy) ground-truth states for every case
benchmark.mjs produced, so report.mjs can check lazy loading's answers
against them -- not just self-consistency."""
import json
import os

import spiceypy as spice

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
RESULTS = os.path.join(HERE, "results")

spice.furnsh(os.path.join(FIXTURES, "de440.bsp"))

with open(os.path.join(RESULTS, "lazy-results.json")) as f:
    cases = json.load(f)

reference = []
for c in cases:
    states = []
    for s in c["states"]:
        state, _lt = spice.spkezr(str(c["target"]), s["et"], "J2000", "NONE", str(c["observer"]))
        states.append(
            {"et": s["et"], "position": [float(x) for x in state[:3]], "velocity": [float(x) for x in state[3:]]}
        )
    reference.append(
        {"body": c["body"], "target": c["target"], "observer": c["observer"], "range": c["range"], "states": states}
    )

with open(os.path.join(RESULTS, "spiceypy-results.json"), "w") as f:
    json.dump(reference, f, indent=2)

print(
    f"Wrote spiceypy reference for {len(reference)} cases "
    f"-> results/spiceypy-results.json (CSPICE {spice.tkvrsn('TOOLKIT')})"
)
