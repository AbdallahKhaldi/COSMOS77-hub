"""Operational JSON: /api/status and /api/runs (operational data only, no boards)."""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Request

from .config import Settings
from .manager import Manager

router = APIRouter()
_BOOTED = time.time()


def _ledger(settings: Settings) -> dict[str, Any] | None:
    """Rule-52 counted ledger from the cop repo, if present (read-only)."""
    path = settings.cop_repo / "artifacts" / "league_ledger.json"
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


@router.get("/api/status")
async def api_status(request: Request) -> dict[str, Any]:
    """Hub posture, active run, agent liveness, viewer count and the ledger."""
    manager: Manager = request.app.state.manager
    settings: Settings = request.app.state.settings
    spec = manager.active
    state = "hold" if manager.hold_active() else ("running" if spec else "standing")
    return {
        "state": state,
        "run": None if spec is None else {
            "run_id": spec.out_stamp, "kind": spec.kind,
            "opponent_gid": spec.opponent_gid, "windows": spec.windows,
        },
        "agents": manager.agents_alive(),
        "viewers": request.app.state.hub.broadcaster.client_count(),
        "seq": request.app.state.hub.log.seq,
        "endpoints": {
            "cop": f"{settings.public_url}/cop/mcp",
            "thief": f"{settings.public_url}/thief/mcp",
        },
        "ledger": _ledger(settings),
        "uptime_s": round(time.time() - _BOOTED, 1),
    }


@router.get("/api/runs")
async def api_runs(request: Request) -> dict[str, Any]:
    """Known runs (from the cop repo's runs/) with settlement and replay flags."""
    settings: Settings = request.app.state.settings
    runs: list[dict[str, Any]] = []
    base = settings.cop_repo / "runs"
    if base.is_dir():
        for entry in sorted(base.iterdir(), reverse=True):
            if not entry.is_dir():
                continue
            settled = any(entry.glob("result_*.json"))
            runs.append({
                "run_id": entry.name,
                "settled": settled,
                "windows_logged": len(list(entry.glob("log_*_g*.json"))),
                "replay": (settings.replays_dir / f"{entry.name}.json").is_file(),
                "mtime": entry.stat().st_mtime,
            })
    return {"runs": runs[:100]}
