"""FastAPI wiring — every route, the lifespan, and nothing clever (contract: HTTP surface).

OpenAPI/Swagger is disabled because /docs is the human challenge guide.  Slash
redirects are globally off: the MCP proxy paths must never answer 3xx.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI
from starlette.staticfiles import StaticFiles

from . import (
    admin,
    challenge,
    config,
    demo,
    doctor,
    pages,
    pair,
    proxy,
    replay,
    secrets_boot,
    status_api,
    ws,
)
from .broadcast import Broadcaster
from .livehub import LiveHub
from .manager import Manager

_TICK_S = 1.0


async def _supervise(manager: Manager) -> None:
    """Drive the manager state machine off the loop (tick blocks on kills)."""
    while True:
        await asyncio.sleep(_TICK_S)
        await asyncio.to_thread(manager.tick)


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Boot: dirs, secrets, proxy client, standing agents, supervisor.  Then undo."""
    settings = app.state.settings
    config.ensure_dirs(settings)
    secrets_boot.materialize(settings)
    supervisor: asyncio.Task[None] | None = None
    if settings.autostart:
        await asyncio.to_thread(app.state.manager.start_standing)
        supervisor = asyncio.create_task(_supervise(app.state.manager))
    try:
        yield
    finally:
        if supervisor is not None:
            supervisor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await supervisor
        app.state.hub.request_stop()
        await asyncio.to_thread(app.state.manager.shutdown)
        await app.state.proxy_client.aclose()


def create_app(settings: config.Settings | None = None) -> FastAPI:
    """Build the hub application (tests pass their own Settings)."""
    settings = settings or config.load()
    app = FastAPI(
        title="COSMOS77 hub", docs_url=None, redoc_url=None, openapi_url=None,
        redirect_slashes=False, lifespan=_lifespan,
    )
    app.state.settings = settings
    hub = LiveHub(settings, Broadcaster())
    hub.on_settled = lambda run_id: replay.try_build(settings, run_id)
    app.state.hub = hub
    app.state.manager = Manager(settings, notify=hub.notify)
    app.state.challenge_gate = challenge.ChallengeGate()
    app.state.demo_gate = challenge.ChallengeGate(cooldown_s=20, daily=200)  # cheap selfplays
    app.state.challenge_resolver = challenge.default_resolver
    app.state.proxy_client = proxy.make_client()  # closed by the lifespan teardown
    for router in (pages.router, proxy.router, challenge.router, doctor.router, demo.router,
                   pair.router, admin.router, replay.router, status_api.router, ws.router):
        app.include_router(router)
    if settings.static_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(settings.static_dir)), name="static")
    return app


app = create_app()
