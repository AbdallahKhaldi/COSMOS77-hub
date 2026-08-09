"""Belief/scent indexes for replays, from OUR police events.jsonl (never the wire).

The agent logs ~2 view lines per step (YOUR TURN + LOCKED); keying by
``(window, step)`` dedupes them — the LAST line per step wins (the post-turn LOCKED
view, matching scent semantics).  ``belief_trace`` then carries EXACTLY one entry
per frame, in frames order, so ``belief_trace[i]`` belongs to ``frames[i]`` and both
carry matching ``window``/``step`` fields (the viewer aligns by step as well).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

Key = tuple[int, int]


def events_indexes(run_dirs: list[Path]) -> tuple[dict[Key, Any], dict[Key, dict[str, Any]]]:
    """Scent and belief keyed by ``(window, step)`` from every candidate run dir."""
    scent: dict[Key, Any] = {}
    belief: dict[Key, dict[str, Any]] = {}
    for run_dir in run_dirs:
        path = run_dir / "events.jsonl"
        if not path.is_file():
            continue
        for raw in path.read_bytes().splitlines():
            try:
                line = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(line, dict) or line.get("role") != "police":
                continue
            window, step = int(line.get("sub_game") or 0), int(line.get("step") or 0)
            scent[(window, step)] = line.get("perceived_scent")
            posterior = line.get("posterior") or {}
            ghost = None
            if posterior:
                best = max(posterior, key=lambda k: posterior[k])
                ghost = [int(p) for p in str(best).split(",")[:2]]
            belief[(window, step)] = {"window": window, "step": step, "ghost": ghost,
                                      "confidence": line.get("confidence")}
    return scent, belief


def belief_trace(
    frames: list[dict[str, Any]], belief: dict[Key, dict[str, Any]]
) -> list[dict[str, Any]]:
    """EXACTLY one belief entry per frame, in frames order (``ghost: None`` when absent)."""
    return [
        belief.get((f["window"], f["step"]),
                   {"window": f["window"], "step": f["step"], "ghost": None,
                    "confidence": None})
        for f in frames
    ]
