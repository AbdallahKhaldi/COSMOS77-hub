"""Bird's-eye replay frames from SETTLED window logs (legal only post-settlement).

Window logs carry both sides' sealed records (positions are mutually revealed at
audit), so a full timeline is reconstructable — and re-verifiable: we recompute
``SHA256(canonical_json(payload) + "|" + nonce)`` for every record, the exact
construction from ``cosmos77_cop.protocol.sealing``.
"""

from __future__ import annotations

import ast
import hashlib
import json
from typing import Any

Record = dict[str, Any]


def canonical_str(obj: object) -> str:
    """Byte-identical twin of the agents' canonical serializer."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def record_ok(record: Record) -> bool:
    """Recompute the commit-reveal seal for one record."""
    payload, nonce, commit = record.get("payload"), record.get("nonce"), record.get("commit")
    if payload is None or nonce is None or commit is None:
        return False
    digest = hashlib.sha256(f"{canonical_str(payload)}|{nonce}".encode()).hexdigest()
    return digest == commit


def _barriers_from_state(state: str | None) -> list[list[int]] | None:
    """Parse ``barriers=[[r, c], ...]`` out of a record's state string."""
    if not state or "barriers=" not in state:
        return None
    try:
        parsed = ast.literal_eval(state.split("barriers=", 1)[1])
        return [[int(r), int(c)] for r, c in parsed]
    except (ValueError, SyntaxError, TypeError):
        return None


def _turns_by_role(doc: dict[str, Any]) -> dict[str, dict[int, Record]]:
    """Index a window log's turn records (skipping step-0 system_spec) by role and step."""
    my_role = doc.get("summary", {}).get("my_role", "police")
    other = "thief" if my_role == "police" else "police"
    out: dict[str, dict[int, Record]] = {"police": {}, "thief": {}}
    sides = ((my_role, doc.get("records", [])), (other, doc.get("opponent_records", [])))
    for role, records in sides:
        for record in records:
            payload = record.get("payload", {})
            if "move" in payload and isinstance(payload.get("step"), int):
                out[role][payload["step"]] = record
    return out


def window_frames(
    doc: dict[str, Any], scent_index: dict[tuple[int, int], dict[str, float]] | None = None
) -> tuple[list[dict[str, Any]], list[bool]]:
    """Frames plus per-step verification bools for ONE settled window log."""
    turns = _turns_by_role(doc)
    window = int(doc.get("sub_game_number") or 0)
    steps = sorted(set(turns["police"]) | set(turns["thief"]))
    frames, per_step = [], []
    cop_pos: list[int] | None = None
    thief_pos: list[int] | None = None
    barriers: list[list[int]] = []
    for step in steps:
        police, thief = turns["police"].get(step), turns["thief"].get(step)
        checked = [record_ok(r) for r in (police, thief) if r is not None]
        ok = bool(checked) and all(checked)
        if police is not None:
            cop_pos = list(police["payload"].get("position") or cop_pos or [])
            barriers = _barriers_from_state(police["payload"].get("state")) or barriers
        if thief is not None:
            thief_pos = list(thief["payload"].get("position") or thief_pos or [])
        scent = (scent_index or {}).get((window, step))
        frames.append({
            "step": step, "window": window,
            "cop": cop_pos, "thief": thief_pos,
            "barriers": [list(b) for b in barriers], "commit_ok": ok,
            "scent": scent,
            "hint": {
                "police": police["payload"].get("hint") if police else None,
                "thief": thief["payload"].get("hint") if thief else None,
            },
        })
        per_step.append(ok)
    return frames, per_step


def all_records_ok(doc: dict[str, Any]) -> bool:
    """Every record in the log (step-0 included) passes the recomputed seal."""
    records = list(doc.get("records", [])) + list(doc.get("opponent_records", []))
    return bool(records) and all(record_ok(r) for r in records)
