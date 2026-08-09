"""Public demo lane: every START press runs a REAL selfplay on the hub.

The arena's START button posts here.  On success the visitor's live socket
streams a fresh genuine game (new strategy every run — the answer to "it's the
same every time"); on refusal (busy / cooldown / quota) the front-end falls
back to the recorded tape.  The lane shares the challenge rate budget, carries
no opponent URLs by construction, and — like every web path — can never be
counted (kind is pinned to selfplay here, and the manager refuses counted
anyway).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .challenge import ChallengeGate
from .manager import Manager
from .runspec import RunRefusedError, RunSpec, fresh_stamp

router = APIRouter()


@router.post("/api/demo")
async def start_demo(request: Request) -> dict[str, str]:
    """Start a one-window public selfplay; the live WS feed carries it."""
    gate: ChallengeGate = request.app.state.challenge_gate
    manager: Manager = request.app.state.manager
    gate.admit()  # raises HTTPException 429 on cooldown/quota
    spec = RunSpec(kind="selfplay", opponent_gid="cosmos77-mirror",
                   windows=1, out_stamp=fresh_stamp("selfplay"))
    try:
        run_id = manager.start_run(spec, source="demo")
    except RunRefusedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    gate.note_started()
    return {"run_id": run_id, "watch": "live"}
