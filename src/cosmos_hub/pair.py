"""POST /api/pair — pairing packet via the cop repo, always by subprocess.

Primary path shells ``uv run cosmos-cop pair --json ...`` (Track A's CLI hook).
Until that subcommand lands, the fallback shells ``uv run python -c`` importing
``cosmos77_cop.console.pairing`` — still a subprocess, never an import into the hub.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .config import Settings
from .runspec import GID_RE

router = APIRouter()
_FALLBACK = """
import json, sys
from cosmos77_cop.console.pairing import build_packet
raw = json.load(open("config/game.json", encoding="utf-8"))
opponent, our_cop, our_thief, their_cop, their_thief = sys.argv[1:6]
packet = build_packet(raw, opponent=opponent, our_cop=our_cop, our_thief=our_thief,
                      their_cop=their_cop, their_thief=their_thief)
print(json.dumps(packet.as_dict()))
"""


def _run(argv: list[str], cwd: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=60, check=False)


def build_packet_subprocess(settings: Settings, opponent: str,
                            their_cop: str, their_thief: str) -> dict[str, Any]:
    """Derive the pairing packet in the cop repo; returns the packet dict."""
    our_cop = f"{settings.public_url}/cop/mcp"
    our_thief = f"{settings.public_url}/thief/mcp"
    cwd = str(settings.cop_repo)
    primary = ["uv", "run", "cosmos-cop", "pair", "--json", "--opponent", opponent,
               "--our-cop", our_cop, "--our-thief", our_thief,
               "--their-cop", their_cop, "--their-thief", their_thief]
    fallback = ["uv", "run", "python", "-c", _FALLBACK,
                opponent, our_cop, our_thief, their_cop, their_thief]
    for argv in (primary, fallback):
        try:
            proc = _run(argv, cwd)
        except subprocess.TimeoutExpired:
            continue
        if proc.returncode == 0 and proc.stdout.strip():
            try:
                packet = json.loads(proc.stdout.strip().splitlines()[-1])
            except json.JSONDecodeError:
                continue
            if isinstance(packet, dict):
                return packet
    raise RuntimeError("pairing packet generation failed in the cop repo")


@router.post("/api/pair")
async def post_pair(request: Request) -> dict[str, Any]:
    """Public pairing generator, on the shared challenge budget.

    Every call shells a subprocess, so an ungated loop is a free fork bomb.
    """
    request.app.state.challenge_gate.admit()  # 429 on cooldown/quota
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "body must be a JSON object")
    opponent = str(body.get("opponent") or body.get("opponent_gid") or "")
    if not GID_RE.match(opponent):
        raise HTTPException(422, "opponent must match [A-Za-z0-9._-]{1,64}")
    their_cop = str(body.get("their_cop_url") or "(theirs)")[:300]
    their_thief = str(body.get("their_thief_url") or "(theirs)")[:300]
    settings: Settings = request.app.state.settings
    try:
        packet = await asyncio.to_thread(
            build_packet_subprocess, settings, opponent, their_cop, their_thief
        )
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    return packet
