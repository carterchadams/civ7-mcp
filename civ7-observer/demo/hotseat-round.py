"""Hotseat robustness round: capture on the expected seat, attempt the other seat, log a row.

Usage: python demo/hotseat-round.py <expected_player> <label>
Appends a JSON line to runs/hotseat-matrix.jsonl and prints a compact summary.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

PY = sys.executable
expected = int(sys.argv[1])
label = sys.argv[2] if len(sys.argv) > 2 else ""
other = 1 - expected
runs = Path("runs"); runs.mkdir(exist_ok=True)


def snapshot(player, out):
    t0 = time.monotonic()
    p = subprocess.run([PY, "-m", "civ7_observer", "snapshot", "--mode", "local-hotseat", "--player", str(player), "--json", "--out", str(out)], capture_output=True, text=True)
    ms = int((time.monotonic() - t0) * 1000)
    return json.loads(p.stdout), ms


ok, ms_ok = snapshot(expected, runs / f"hotseat-p{expected}-{label}.json")
bad, ms_bad = snapshot(other, runs / "should-not-exist.json")
row = {"label": label, "expectedPlayer": expected, "capture": None, "wrongSeat": None}
if ok.get("ok"):
    doc = json.loads(Path(ok["path"]).read_text())
    row["capture"] = {"observationId": doc["observationId"][:8], "turn": doc["context"]["turn"], "playerId": doc["context"]["playerId"],
                      "settlements": len(doc["settlements"]), "units": len(doc["units"]), "visible": doc["map"]["counts"]["visible"],
                      "techCurrent": doc["technology"]["current"] and doc["technology"]["current"]["typeKey"], "warnings": doc["warnings"], "ms": ms_ok}
else:
    row["capture"] = {"error": ok.get("error"), "ms": ms_ok}
row["wrongSeat"] = {"error": bad.get("error", {}).get("code") if not bad.get("ok") else "UNEXPECTED SUCCESS", "fileExists": (runs / "should-not-exist.json").exists()}
with open(runs / "hotseat-matrix.jsonl", "a") as fh:
    fh.write(json.dumps(row) + "\n")
print(json.dumps(row))
