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
async def start_demo(request: Request) -> dict[str, str | bool]:
    """Start a one-window public selfplay — or join the run already playing.

    A press while a game is live ATTACHES the viewer to that game (watching is
    free) instead of refusing; only true back-to-back restarts hit the short
    demo cooldown, and the recorded tape remains the front-end's last resort.
    """
    gate: ChallengeGate = request.app.state.demo_gate
    manager: Manager = request.app.state.manager
    active = manager.active
    if active is not None:
        return {"run_id": active.out_stamp, "watch": "live", "joined": True,
                "server_paced": True}
    gate.admit()  # raises HTTPException 429 on cooldown/quota
    spec = RunSpec(kind="selfplay", opponent_gid="cosmos77-mirror",
                   windows=1, out_stamp=fresh_stamp("selfplay"))
    try:
        run_id = manager.start_run(spec, source="demo")
    except RunRefusedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    gate.note_started()
    return {"run_id": run_id, "watch": "live", "joined": False, "server_paced": True}
