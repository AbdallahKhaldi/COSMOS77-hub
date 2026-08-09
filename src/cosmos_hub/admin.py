"""Admin surface: password login -> HMAC-signed session cookie (stdlib only).

Endpoints: /api/admin/run | stop | logs | report-dry-run.  Everything 401s without a
valid cookie.  Counted can NEVER pass here — kind and argv rails return 403 and the
report preview is structurally friendly-only (no --send, no --counted).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
import subprocess
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse

from .argvs import report_dry_run_argv
from .config import Settings
from .manager import Manager
from .runspec import RUN_ID_RE, CountedRefusedError, RunRefusedError, web_runspec

router = APIRouter()
COOKIE = "hub_admin"
SESSION_TTL_S = 12 * 3600
_SECRET = secrets.token_bytes(32)  # per-boot: restarting the hub logs admins out


def _sign(payload: str) -> str:
    return hmac.new(_SECRET, payload.encode(), hashlib.sha256).hexdigest()


def make_token(now: float | None = None) -> str:
    """Issue ``<timestamp>.<hmac>`` proving login happened this boot."""
    stamp = str(int(now if now is not None else time.time()))
    return f"{stamp}.{_sign(stamp)}"


def token_valid(token: str, now: float | None = None) -> bool:
    """Constant-time check of signature and age."""
    stamp, _, signature = token.partition(".")
    if not stamp.isdigit() or not signature:
        return False
    if not hmac.compare_digest(signature, _sign(stamp)):
        return False
    age = (now if now is not None else time.time()) - int(stamp)
    return 0 <= age <= SESSION_TTL_S


def require_admin(request: Request) -> None:
    """401 unless the request carries a valid session cookie."""
    token = request.cookies.get(COOKIE, "")
    if not token or not token_valid(token):
        raise HTTPException(401, "admin login required")


@router.post("/api/admin/login")
async def login(request: Request) -> JSONResponse:
    """Exchange HUB_ADMIN_PASSWORD for a session cookie."""
    settings: Settings = request.app.state.settings
    if not settings.admin_password:
        raise HTTPException(503, "admin disabled: HUB_ADMIN_PASSWORD not set")
    body = await request.json()
    supplied = str(body.get("password", "")) if isinstance(body, dict) else ""
    if not hmac.compare_digest(supplied, settings.admin_password):
        raise HTTPException(401, "wrong password")
    response = JSONResponse({"ok": True})
    # Secure on an https deployment (RAILWAY_PUBLIC_DOMAIN ⇒ https public_url), so the
    # session token never rides plain http to the edge; local http dev keeps working.
    response.set_cookie(COOKIE, make_token(), max_age=SESSION_TTL_S, httponly=True,
                        samesite="lax", path="/",
                        secure=settings.public_url.startswith("https://"))
    return response


@router.post("/api/admin/run")
async def admin_run(request: Request) -> dict[str, str]:
    """Start selfplay/f1/f2 with an arbitrary peer.  Counted -> 403, always."""
    require_admin(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "body must be a JSON object")
    manager: Manager = request.app.state.manager
    try:
        spec = web_runspec(body)
        run_id = manager.start_run(spec, source="admin")
    except CountedRefusedError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RunRefusedError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"run_id": run_id, "watch_url": f"/?run={run_id}"}


@router.post("/api/admin/stop")
async def admin_stop(request: Request) -> dict[str, bool]:
    """Stop the active run (agents return to standing)."""
    require_admin(request)
    manager: Manager = request.app.state.manager
    return {"stopped": manager.stop_run()}


@router.get("/api/admin/logs")
async def admin_logs(request: Request, name: str = "", lines: int = 100) -> dict[str, Any]:
    """Tail one captured agent log, or list the available ones."""
    require_admin(request)
    settings: Settings = request.app.state.settings
    available = sorted(p.name for p in settings.logs_dir.glob("*.log"))
    if not name:
        return {"logs": available}
    if name not in available:
        raise HTTPException(404, "unknown log")
    text = (settings.logs_dir / name).read_text(encoding="utf-8", errors="replace")
    return {"name": name, "tail": text.splitlines()[-max(1, min(lines, 1000)):]}


@router.post("/api/admin/report-dry-run")
async def admin_report_dry_run(request: Request) -> dict[str, Any]:
    """Preview the friendly report for a settled run.  Never sends, never counted."""
    require_admin(request)
    body = await request.json()
    run_id = str(body.get("run_id", "")) if isinstance(body, dict) else ""
    if not RUN_ID_RE.match(run_id):
        raise HTTPException(422, "run_id required")
    settings: Settings = request.app.state.settings
    results = sorted(p for d in settings.run_dirs(run_id) for p in d.glob("result_*.json"))
    if not results:
        raise HTTPException(404, "no settled result for that run")
    argv = report_dry_run_argv(str(results[0]))  # absolute: runs live on the data volume
    proc = await asyncio.to_thread(
        subprocess.run, argv, cwd=str(settings.cop_repo),
        capture_output=True, text=True, timeout=120, check=False,
    )
    return {"rc": proc.returncode, "output": (proc.stdout + proc.stderr)[-8000:]}
