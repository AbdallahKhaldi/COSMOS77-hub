"""WS /ws/live?perspective=police|thief — snapshot on connect, then that feed only.

One perspective per socket is enforced server-side: the perspective is bound at accept
time and nothing a client sends can change it (inbound frames are read and discarded).
Idle sockets get a ``ping`` envelope every 20 s; slow ones lose oldest frames first.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .broadcast import PERSPECTIVES
from .livehub import LiveHub

router = APIRouter()
PING_INTERVAL_S = 20.0


async def _pump(websocket: WebSocket, hub: LiveHub, perspective: str) -> None:
    """Catch a viewer up, then stream.

    Mid-run: one composed snapshot (the rebase).  After a finished run: replay the
    retained envelope history so even a seconds-fast game is fully watchable.  The
    queue subscription happens FIRST so nothing published in between is lost (the
    client's timeline dedupes by seq).
    """
    queue = hub.broadcaster.subscribe(perspective)
    snapshot = hub.log.snapshot_envelope(perspective)
    payload = snapshot.get("payload") or {}
    history = hub.broadcaster.history_for(perspective)
    has_game = any(e.get("type") == "view" for e in history)
    try:
        if isinstance(payload, dict) and payload.get("view"):
            await websocket.send_json(snapshot)  # live rebase
        elif has_game:
            for envelope in history:             # finished-run replay
                await websocket.send_json(envelope)
        else:
            await websocket.send_json(snapshot)  # clean standing
        while True:
            try:
                envelope = await asyncio.wait_for(queue.get(), timeout=PING_INTERVAL_S)
            except asyncio.TimeoutError:  # noqa: UP041 - explicit for 3.11 wait_for
                await websocket.send_json({"type": "ping", "ts": time.time()})
                continue
            await websocket.send_json(envelope)
    finally:
        hub.broadcaster.unsubscribe(perspective, queue)


@router.websocket("/ws/live")
async def ws_live(websocket: WebSocket) -> None:
    """Live bodycam feed for exactly one perspective."""
    perspective = websocket.query_params.get("perspective", "")
    if perspective not in PERSPECTIVES:
        await websocket.close(code=4400, reason="perspective must be police|thief")
        return
    hub: LiveHub = websocket.app.state.hub
    await websocket.accept()
    sender = asyncio.create_task(_pump(websocket, hub, perspective))
    try:
        while True:  # inbound frames are ignored: perspective can never be switched
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sender
