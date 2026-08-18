"""Per-opponent pairing constitutions: install once, every challenge plays under them.

Different teams legitimately bring different agreed files (sharNamr's says Haifa, ours
says New York — ``setting`` is a flat term, so the bytes must match on both sides or
the handshake refuses).  The library lives on the data volume keyed by opponent gid;
installing is ADMIN-gated and every file is validated by the COP REPO'S OWN loader in
a subprocess — the same code that would refuse it at spawn, so a bad file is refused
at upload time with the agent's real error instead of at T with a dead window.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .admin import require_admin
from .argvs import _venv_bin
from .config import Settings
from .runspec import GID_RE

router = APIRouter()
_VALIDATE = (
    "import sys, json\n"
    "from cosmos77_cop.engine.config import load_game_config\n"
    "c = load_game_config(sys.argv[1])\n"
    "print(json.dumps({'grid': c.grid_size, 'moves': c.max_moves,"
    " 'barriers': c.max_barriers, 'map': c.raw['world']['map_area']}))\n"
)


def pairing_config_path(settings: Settings, gid: str) -> Path:
    """Where *gid*'s agreed constitution lives on the volume."""
    return settings.data_dir / "configs" / "pairings" / f"{gid}.json"


def active_pairing_config(settings: Settings, gid: str) -> str | None:
    """The installed config path for *gid*, or None to play our constitution."""
    path = pairing_config_path(settings, gid)
    return str(path) if path.is_file() else None


def _validate_with_agent_loader(settings: Settings, path: Path) -> dict[str, Any]:
    """Run the cop repo's own validator over the candidate file (refusal = its words)."""
    proc = subprocess.run(
        [_venv_bin(settings, "cop", "python"), "-c", _VALIDATE, str(path)],
        cwd=str(settings.cop_repo), capture_output=True, text=True, timeout=60, check=False,
    )
    if proc.returncode != 0:
        raise HTTPException(422, f"the agents refuse this config: {proc.stderr.strip()[-400:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


@router.post("/api/admin/pairing-config")
async def install_pairing_config(request: Request) -> dict[str, Any]:
    """Install one opponent's agreed game.json; Engage then plays THEIR file for that gid."""
    require_admin(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "body must be a JSON object")
    gid = str(body.get("gid", ""))
    if not GID_RE.match(gid):
        raise HTTPException(422, "gid must match [A-Za-z0-9._-]{1,64}")
    config = body.get("config")
    if not isinstance(config, dict):
        raise HTTPException(422, "config must be the game.json OBJECT (not a string)")
    settings: Settings = request.app.state.settings
    path = pairing_config_path(settings, gid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        summary = await asyncio.to_thread(_validate_with_agent_loader, settings, path)
    except HTTPException:
        path.unlink(missing_ok=True)  # never leave a refused file where Engage could find it
        raise
    import hashlib

    sha = hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()
    return {"installed": gid, "canonical_sha256": sha, "summary": summary}


@router.get("/api/admin/pairing-config")
async def list_pairing_configs(request: Request) -> dict[str, Any]:
    """Installed pairing constitutions, by gid."""
    require_admin(request)
    settings: Settings = request.app.state.settings
    root = settings.data_dir / "configs" / "pairings"
    return {"installed": sorted(p.stem for p in root.glob("*.json")) if root.is_dir() else []}
