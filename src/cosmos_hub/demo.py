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

import contextlib

from fastapi import APIRouter, HTTPException, Request

from . import custom
from .challenge import ChallengeGate
from .manager import Manager
from .runspec import RunRefusedError, RunSpec, fresh_stamp

router = APIRouter()


@router.post("/api/demo")
async def start_demo(request: Request) -> dict[str, object]:
    """Start a one-window public selfplay — or join the run already playing.

    A press while a game is live ATTACHES the viewer to that game (watching is
    free) instead of refusing; only true back-to-back restarts hit the short
    demo cooldown, and the recorded tape remains the front-end's last resort.
    """
    gate: ChallengeGate = request.app.state.demo_gate
    manager: Manager = request.app.state.manager
    body = {}
    with contextlib.suppress(Exception):  # a bodyless press is the common case
        body = await request.json()
    if not isinstance(body, dict):
        body = {}
    active = manager.active
    if active is not None and not body:
        # a plain press while a pursuit runs: watching is free, no new game
        return {"run_id": active.out_stamp, "watch": "live", "joined": True,
                "server_paced": True}
    gate.admit()  # raises HTTPException 429 on cooldown/quota
    if active is not None:
        manager.stop_run()  # chosen rules mean a NEW game, never a silent join
    settings = request.app.state.settings
    base = custom.league_config(settings)
    rules = custom.wanted(body, base)
    stamp = fresh_stamp("selfplay")
    config_path = None
    if not custom.is_default(rules, base):
        config_path = str(custom.write_config(settings, stamp,
                                              custom.build_config(base, rules)))
    spec = RunSpec(kind="selfplay", opponent_gid="cosmos77-mirror",
                   windows=rules["windows"], out_stamp=stamp,
                   config_path=config_path, dwell_ms=rules["dwell_ms"])
    try:
        run_id = manager.start_run(spec, source="demo")
    except RunRefusedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    gate.note_started()
    return {"run_id": run_id, "watch": "live", "joined": False, "server_paced": True,
            "rules": {k: v for k, v in rules.items() if not k.startswith("_")}}
