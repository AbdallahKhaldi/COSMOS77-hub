"""Viewer envelopes — seq-stamped, per-perspective, local-truth-only (hard rail).

The hub is the ONLY seq assigner.  Whitelists below are the legality boundary: window
and series artifacts contain post-reveal positions (`records`), which must never reach
the live channel — only operational fields pass.
"""

from __future__ import annotations

import time
from typing import Any

from .broadcast import PERSPECTIVES, Broadcaster, Envelope

_VIEW_FIELDS = (
    "role", "sub_game", "step", "banner", "self_pos", "barriers", "barriers_left",
    "posterior", "perceived_scent", "confidence", "hints",
)
_SUMMARY_FIELDS = ("result", "my_role", "steps", "reason", "settled")


def view_payload(line: dict[str, Any]) -> dict[str, Any]:
    """One agent's own LiveView fields — never the opponent's truth."""
    return {key: line.get(key) for key in _VIEW_FIELDS}


def window_end_payload(log_doc: dict[str, Any]) -> dict[str, Any]:
    """Operational summary of a settled window: scores and outcome, NO records."""
    summary = log_doc.get("summary", {})
    row = summary.get("row", {}) or {}
    return {
        "sub_game": log_doc.get("sub_game_number"),
        **{key: summary.get(key) for key in _SUMMARY_FIELDS},
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


class EnvelopeLog:
    """Per-run monotonic seq counter plus the per-perspective snapshot state."""

    def __init__(self, broadcaster: Broadcaster, run_id: str) -> None:
        """Bind to *broadcaster*; seq restarts at 0 for every run."""
        self.broadcaster = broadcaster
        self.run_id = run_id
        self.seq = 0
        self.snapshots: dict[str, dict[str, Any]] = {
            p: {"run_id": run_id, "perspective": p} for p in PERSPECTIVES
        }

    def emit(self, type_: str, perspective: str, payload: dict[str, Any]) -> Envelope:
        """Stamp, snapshot and publish one envelope (hub-loop thread)."""
        self.seq += 1
        envelope: Envelope = {
            "seq": self.seq, "ts": time.time(), "run_id": self.run_id,
            "perspective": perspective, "type": type_, "payload": payload,
        }
        snap = self.snapshots[perspective]
        if type_ == "view":
            snap["view"] = payload
        elif type_ == "window_end":
            snap.setdefault("windows", []).append(payload)
        elif type_ == "series_end":
            snap["final"] = payload
        elif type_ == "status":
            snap["status"] = payload
        self.broadcaster.publish(envelope)
        return envelope

    def emit_both(self, type_: str, payload: dict[str, Any]) -> None:
        """Emit the same operational payload to both perspectives (status et al.)."""
        for perspective in PERSPECTIVES:
            self.emit(type_, perspective, payload)

    def snapshot_envelope(self, perspective: str) -> Envelope:
        """Current composed state for *perspective*, stamped with the current seq."""
        return {
            "seq": self.seq, "ts": time.time(), "run_id": self.run_id,
            "perspective": perspective, "type": "snapshot",
            "payload": dict(self.snapshots[perspective]),
        }
