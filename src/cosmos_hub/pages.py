"""HTML page routes — templates/{index,replay,docs,league,admin}.html (Track C owns content).

Serving is by exact filename; when a template is missing (Track C mid-build) a tiny
inline placeholder answers 200 so the arena never 404s on its public pages.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.responses import FileResponse, HTMLResponse, PlainTextResponse, Response

from .config import Settings

router = APIRouter()


def _page(request: Request, name: str) -> Response:
    """FileResponse for a template, or a minimal placeholder when absent."""
    settings: Settings = request.app.state.settings
    path = settings.templates_dir / name
    if path.is_file():
        return FileResponse(path, media_type="text/html")
    body = f"<!doctype html><title>COSMOS77</title><h1>COSMOS77 arena</h1><p>{name} pending.</p>"
    return HTMLResponse(body)


@router.get("/health", include_in_schema=False)
async def health() -> PlainTextResponse:
    """Railway healthcheck: 200 'ok'."""
    return PlainTextResponse("ok")


@router.get("/", include_in_schema=False)
async def index(request: Request) -> Response:
    """Arena: live bodycam or attract mode."""
    return _page(request, "index.html")


@router.get("/replay/{run_id}", include_in_schema=False)
async def replay_page(request: Request, run_id: str) -> Response:
    """Bird's-eye replay of one settled run (data via /api/replays/{run_id})."""
    del run_id  # the page script reads it from location.pathname
    return _page(request, "replay.html")


@router.get("/docs", include_in_schema=False)
async def docs_page(request: Request) -> Response:
    """Challenge-us guide + pairing generator UI (NOT OpenAPI — that is disabled)."""
    return _page(request, "docs.html")


@router.get("/league", include_in_schema=False)
async def league_page(request: Request) -> Response:
    """Ledger scoreboard."""
    return _page(request, "league.html")


@router.get("/admin", include_in_schema=False)
async def admin_page(request: Request) -> Response:
    """Admin console (auth happens on the /api/admin endpoints, not the page)."""
    return _page(request, "admin.html")
