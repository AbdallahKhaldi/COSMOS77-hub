"""Build and serve post-settlement replays: data/replays/<run_id>.json (contract: Replay).

Only settled series get a replay — an unsettled run is refused with 409.  Source
artifacts are read-only bytes; the replay JSON is the hub's own derived document.
Belief trace (ghost-vs-truth) comes from OUR police events.jsonl, never from the
wire, and carries EXACTLY one entry per frame — ``belief_trace[i]`` belongs to
``frames[i]`` and both carry matching ``window``/``step`` fields.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse

from .belief import belief_trace, events_indexes
from .config import Settings
from .frames import all_records_ok, window_frames
from .runspec import RUN_ID_RE

log = logging.getLogger(__name__)
router = APIRouter()


class NotSettledError(Exception):
    """The series has not settled — no replay may exist yet."""


def _load(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def build(settings: Settings, run_id: str) -> dict[str, Any]:
    """Compose the replay document for *run_id*; raises :class:`NotSettledError` early."""
    dirs = settings.run_dirs(run_id)
    primary = next((d for d in dirs if d.is_dir()), None)
    if primary is None:
        raise FileNotFoundError(run_id)
    results = [p for d in dirs for p in sorted(d.glob("result_*.json"))]
    if not results:
        raise NotSettledError(run_id)
    result = _load(results[0])
    logs: dict[str, Path] = {}
    for directory in dirs:
        for path in sorted(directory.glob("log_*_g*.json")):
            logs.setdefault(path.name, path)
    scent_index, belief_index = events_indexes(dirs)
    frames: list[dict[str, Any]] = []
    per_step: list[bool] = []
    sealed_ok = True
    for name in sorted(logs):
        doc = _load(logs[name])
        if not doc.get("summary", {}).get("settled"):
            raise NotSettledError(f"{run_id}:{name}")
        window, checks = window_frames(doc, scent_index)
        frames.extend(window)
        per_step.extend(checks)
        sealed_ok = sealed_ok and all_records_ok(doc)
    if not per_step:
        verdict = "NOT PLAYED (technical window — no sealed moves to audit)"
    elif all(per_step) and sealed_ok:
        verdict = "Verified OK"
    else:
        verdict = "TAMPERED"
    return {
        "meta": {"run_id": run_id, "game_id": result.get("game_id"),
                 "game_uid": result.get("game_uid"), "windows": len(logs),
                 "final_result": result.get("final_result"),
                 # the settlement fingerprint BOTH teams read aloud after a game —
                 # byte-equal on both sides proves the two reports will agree (rule 35)
                 "mutual_agreement": result.get("mutual_agreement"),
                 "built_ts": time.time()},
        "frames": frames,
        "verify": {"per_step": per_step, "verdict": verdict},
        "belief_trace": belief_trace(frames, belief_index),
    }


def build_and_store(settings: Settings, run_id: str) -> Path:
    """Build the replay and persist it under the hub data volume."""
    document = build(settings, run_id)
    settings.replays_dir.mkdir(parents=True, exist_ok=True)
    path = settings.replays_dir / f"{run_id}.json"
    path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    return path


def try_build(settings: Settings, run_id: str) -> None:
    """Best-effort build hook for run-end notifications (never raises)."""
    try:
        build_and_store(settings, run_id)
        log.info("replay built for %s", run_id)
    except NotSettledError:
        log.info("run %s ended unsettled: no replay", run_id)
    except Exception:  # a replay failure must never hurt the hub
        log.exception("replay build failed for %s", run_id)


@router.get("/api/replays/{run_id}")
async def get_replay(run_id: str, request: Request) -> JSONResponse:
    """Serve a settled replay; 409 while unsettled, 404 when unknown."""
    if not RUN_ID_RE.match(run_id):
        raise HTTPException(status_code=404, detail="unknown run")
    settings: Settings = request.app.state.settings
    stored = settings.replays_dir / f"{run_id}.json"
    if not stored.is_file():
        try:
            stored = build_and_store(settings, run_id)
        except NotSettledError as exc:
            raise HTTPException(status_code=409, detail="run not settled yet") from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="unknown run") from exc
    return JSONResponse(json.loads(stored.read_text(encoding="utf-8")))
