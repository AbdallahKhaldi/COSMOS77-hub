"""Operational JSON: /api/status and /api/runs (operational data only, no boards)."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from . import custom
from .config import Settings
from .manager import Manager
from .runspec import RunSpec

router = APIRouter()
_BOOTED = time.time()


def board_grid(settings: Settings, spec: RunSpec | None) -> int:
    """The board size the VIEWER must build for before it draws anything.

    A sandbox run carries its own generated config, so the arena cannot assume the
    league board: built for 7 while a 10x10 plays, the city and the belief map both
    silently drop every cell from index 7 up.
    """
    for source in ((Path(spec.config_path),) if spec is not None and spec.config_path else ()):
        try:
            raw = json.loads(source.read_text(encoding="utf-8"))
            return int(raw["board_and_agents"]["grid_size"])
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            break
    try:
        return int(custom.league_config(settings)["board_and_agents"]["grid_size"])
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return 7


def _ledger(settings: Settings) -> dict[str, Any] | None:
    """Rule-52 counted ledger (read-only): repo copy first, volume twin as fallback."""
    for path in (settings.repo_ledger_file, settings.ledger_file):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(doc, dict):
            return doc
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
        "grid": board_grid(settings, spec),
        "agents": manager.agents_alive(),  # includes "relay" (backs the /mcp single URL)
        "viewers": request.app.state.hub.broadcaster.client_count(),
        "seq": request.app.state.hub.log.seq,
        "endpoints": {
            "cop": f"{settings.public_url}/cop/mcp",
            "thief": f"{settings.public_url}/thief/mcp",
            "single": f"{settings.public_url}/mcp",
        },
        "ledger": _ledger(settings),
        "uptime_s": round(time.time() - _BOOTED, 1),
    }


def _result_summary(result_path: Path, ours: str) -> dict[str, Any]:
    """League-row fields from a settled result artifact; {} when unreadable."""
    try:
        final = json.loads(result_path.read_text(encoding="utf-8"))["final_result"]
        totals = final["total_score"]
        them_gid = next((g for g in totals if g != ours), None)
        winner = final.get("winner_group")
        verdict = ("tie" if final.get("series_tie") or winner is None
                   else "win" if winner == ours else "loss")
        return {"opponent": them_gid, "us": totals.get(ours),
                "them": totals.get(them_gid), "verdict": verdict}
    except Exception:  # a corrupt artifact must not take the league page down
        return {}


@router.get("/api/runs")
async def api_runs(request: Request) -> dict[str, Any]:
    """Known runs (from the data volume's runs/ trees) with settlement and replay flags."""
    settings: Settings = request.app.state.settings
    index: dict[str, dict[str, Any]] = {}
    for base in (settings.runs_root / "shared", settings.runs_root / "cop",
                 settings.runs_root / "thief"):
        if not base.is_dir():
            continue
        for entry in base.iterdir():
            if not entry.is_dir():
                continue
            row = index.setdefault(entry.name, {
                "run_id": entry.name, "kind": entry.name.split("-")[0],
                "settled": False, "windows_logged": 0,
                "replay": (settings.replays_dir / f"{entry.name}.json").is_file(),
                "mtime": 0.0, "_logs": set(),
            })
            if not row["settled"] and (results := sorted(entry.glob("result_*.json"))):
                row["settled"] = True
                row.update(_result_summary(results[0], settings.standing_gids))
            row["_logs"].update(p.name for p in entry.glob("log_*_g*.json"))
            row["mtime"] = max(row["mtime"], entry.stat().st_mtime)
    runs = sorted(index.values(), key=lambda r: r["run_id"], reverse=True)
    for row in runs:
        row["windows_logged"] = len(row.pop("_logs"))
    return {"runs": runs[:100]}
