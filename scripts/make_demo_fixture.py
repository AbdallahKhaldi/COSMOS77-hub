"""Rebuild static/fixtures/demo-live.json from a REAL settled selfplay run pair.

The fixture must speak THE HUB DIALECT — the exact envelope payloads
``src/cosmos_hub/envelopes.py`` composes from run artifacts — so the demo tape
exercises the same reducer paths as a live run (one dialect end to end).

This script re-derives the payload shapes from the artifacts directly (it never
imports the hub package, so it runs standalone): views from each repo's
``events.jsonl`` (the ``_VIEW_FIELDS`` subset), ``window_end`` from each
``log_*_gNN.json`` (perspective = ``summary.my_role``), ``series_end`` from the
first ``result_*.json`` (emitted to both perspectives), plus a ``run_started``
status and one composed snapshot per perspective at the head of the tape.

Usage (from the hub repo root)::

    python3 scripts/make_demo_fixture.py [run-stamp]

Default run-stamp: ``selfplay-20260809-012233`` (both agent repos hold a copy
of this settled series — the demo tape's source of truth).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

HUB = Path(__file__).resolve().parents[1]
WORKSPACE = HUB.parent
RUN_STAMP_DEFAULT = "selfplay-20260809-012233"
RUN_ID = "demo-real-012233"
TS_BASE = 1754700000.0

# Mirrors envelopes.py — keep in sync with the hub composer's whitelists.
VIEW_FIELDS = (
    "role", "sub_game", "step", "banner", "self_pos", "barriers", "barriers_left",
    "posterior", "perceived_scent", "confidence", "hints",
)
SUMMARY_FIELDS = ("result", "my_role", "steps", "reason", "settled")


def view_payload(line: dict[str, Any]) -> dict[str, Any]:
    """One agent's own LiveView fields — never the opponent's truth."""
    return {key: line.get(key) for key in VIEW_FIELDS}


def window_end_payload(log_doc: dict[str, Any]) -> dict[str, Any]:
    """Operational summary of a settled window: scores and outcome, NO records."""
    summary = log_doc.get("summary", {})
    row = summary.get("row", {}) or {}
    return {
        "sub_game": log_doc.get("sub_game_number"),
        **{key: summary.get(key) for key in SUMMARY_FIELDS},
        "score": row.get("score"),
        "winner_group": row.get("winner_group"),
        "roles": row.get("roles"),
    }


def series_end_payload(result_doc: dict[str, Any]) -> dict[str, Any]:
    """Series totals from the result artifact (operational data only)."""
    return {
        "game_id": result_doc.get("game_id"),
        "num_sub_games": result_doc.get("num_sub_games"),
        "final_result": result_doc.get("final_result"),
        "mutual_agreement": result_doc.get("mutual_agreement"),
    }


def read_views(run_dir: Path) -> list[dict[str, Any]]:
    """All view lines of one repo's events.jsonl, in file order."""
    out: list[dict[str, Any]] = []
    for raw in (run_dir / "events.jsonl").read_bytes().splitlines():
        try:
            line = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(line, dict) and line.get("role") in ("police", "thief"):
            out.append(line)
    return out


def game_order(line: dict[str, Any]) -> tuple[int, int, int, int]:
    """Merge key: window, step, thief first (moves first), YOUR TURN before LOCKED."""
    return (int(line.get("sub_game") or 0), int(line.get("step") or 0),
            0 if line.get("role") == "thief" else 1,
            0 if line.get("banner") == "YOUR TURN" else 1)


def build(cop_dir: Path, thief_dir: Path) -> list[dict[str, Any]]:
    """Compose the full envelope tape (both perspectives, one hub seq space)."""
    views = sorted(read_views(cop_dir) + read_views(thief_dir), key=game_order)
    logs = sorted([*cop_dir.glob("log_*_g*.json"), *thief_dir.glob("log_*_g*.json")],
                  key=lambda p: p.name)
    results = sorted([*cop_dir.glob("result_*.json"), *thief_dir.glob("result_*.json")],
                     key=lambda p: p.name)
    windows = len({json.loads(p.read_text(encoding="utf-8"))["sub_game_number"] for p in logs})

    tape: list[dict[str, Any]] = []

    def emit(type_: str, perspective: str, payload: dict[str, Any]) -> None:
        tape.append({"seq": len(tape) + 1, "ts": round(TS_BASE + len(tape) * 0.9, 1),
                     "run_id": RUN_ID, "perspective": perspective,
                     "type": type_, "payload": payload})

    status = {"state": "running", "run_id": RUN_ID, "kind": "selfplay",
              "opponent": "cosmos77-mirror", "windows": windows}
    for perspective in ("police", "thief"):
        emit("status", perspective, dict(status))
    for perspective in ("police", "thief"):  # the WS on-connect snapshot, composed
        emit("snapshot", perspective,
             {"run_id": RUN_ID, "perspective": perspective, "status": dict(status)})
    for line in views:
        emit("view", str(line["role"]), view_payload(line))
    for path in logs:
        doc = json.loads(path.read_text(encoding="utf-8"))
        perspective = doc.get("summary", {}).get("my_role")
        if perspective in ("police", "thief"):
            emit("window_end", perspective, window_end_payload(doc))
    if results:
        doc = json.loads(results[0].read_text(encoding="utf-8"))
        for perspective in ("police", "thief"):
            emit("series_end", perspective, series_end_payload(doc))
    return tape


def main() -> int:
    """Rebuild the fixture; prints a one-line summary."""
    stamp = sys.argv[1] if len(sys.argv) > 1 else RUN_STAMP_DEFAULT
    cop_dir = WORKSPACE / "COSMOS77-cop" / "runs" / stamp
    thief_dir = WORKSPACE / "COSMOS77-thief" / "runs" / stamp
    tape = build(cop_dir, thief_dir)
    out = HUB / "static" / "fixtures" / "demo-live.json"
    out.write_text(json.dumps(tape, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    kinds = sorted({env["type"] for env in tape})
    print(f"wrote {out} — {len(tape)} envelopes ({', '.join(kinds)}) from {stamp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
