"""Public ``POST /api/doctor`` — pairing diagnosis via the cop repo's doctor CLI.

Body: ``{url}`` OR ``{cop_url, thief_url}`` (+ optional ``gid``).  The route shares
the ChallengeGate budget (90 s cooldown, 10/day), applies the SAME SSRF rails as
``/api/challenge`` BEFORE shelling anything, and shells ``uv run cosmos-cop doctor
--json ...`` (argv list only, cwd = cop repo, 60 s timeout).  Success returns the
doctor JSON verbatim plus ``elapsed_ms``; garbage output is a 502 error envelope;
a missing subcommand is 503; a timeout is 504.

TOCTOU boundary (accepted residual risk): ``check_url`` resolves the hostname ONCE
at validation time, while the spawned doctor/agent subprocess re-resolves at dial
time — a DNS-rebinding host (TTL-0 public→private flip) can therefore slip past the
private/loopback refusal.  The blast radius is bounded by the https-only rule (our
internal services speak plain HTTP, so their TLS handshakes fail), the shared rate
budget, and the 60 s cap; pinning the validated IP would break SNI/vhost opponents,
so the check is documented as best-effort rather than re-resolved downstream.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse

from .argvs import doctor_argv
from .challenge import ChallengeGate, Resolver, check_url
from .config import Settings
from .runspec import GID_RE

router = APIRouter()
TIMEOUT_S = 60.0
_TAIL = 2000
_USAGE_MARKERS = ("usage:", "unknown subcommand", "unrecognized arguments",
                  "invalid choice", "no such option")


def parse_doctor_json(stdout: str) -> dict[str, Any] | None:
    """Best-effort JSON object from stdout (whole output, then last JSON-looking line)."""
    for candidate in (stdout, *reversed(stdout.splitlines())):
        text = candidate.strip()
        if not text.startswith("{"):
            continue
        try:
            doc = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(doc, dict):
            return doc
    return None


def _validated(body: dict[str, Any], resolver: Resolver) -> tuple[str | None, ...]:
    """SSRF-check the payload exactly like /api/challenge; nothing shells before this."""
    for value in body.values():
        if isinstance(value, str) and "--counted" in value:
            raise HTTPException(403, "counted is never web-reachable")
    url = str(body.get("url") or "") or None
    cop = str(body.get("cop_url") or "") or None
    thief = str(body.get("thief_url") or "") or None
    if url:
        check_url(url, resolver)
        cop = thief = None
    elif cop and thief:
        check_url(cop, resolver)
        check_url(thief, resolver)
    else:
        raise HTTPException(422, "provide url, or cop_url + thief_url")
    gid = str(body.get("gid") or "") or None
    if gid and (gid.startswith("-") or not GID_RE.match(gid)):
        raise HTTPException(422, "gid must match [A-Za-z0-9._-]{1,64}, no leading '-'")
    return url, cop, thief, gid


@router.post("/api/doctor", response_model=None)
async def post_doctor(request: Request) -> dict[str, Any] | JSONResponse:
    """Diagnose pairing compatibility against the caller's endpoint(s)."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "body must be a JSON object")
    url, cop, thief, gid = await asyncio.to_thread(
        _validated, body, request.app.state.challenge_resolver)
    gate: ChallengeGate = request.app.state.challenge_gate
    gate.admit()
    gate.note_started()  # a spawned doctor consumes budget even if it later fails
    settings: Settings = request.app.state.settings
    argv = doctor_argv(request.app.state.settings, url=url, cop_url=cop, thief_url=thief, gid=gid)
    started = time.monotonic()
    try:
        proc = await asyncio.to_thread(
            subprocess.run, argv, cwd=str(settings.cop_repo),
            capture_output=True, text=True, timeout=TIMEOUT_S, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, f"doctor timed out after {int(TIMEOUT_S)}s") from exc
    except FileNotFoundError as exc:
        raise HTTPException(503, "doctor unavailable") from exc
    elapsed_ms = int((time.monotonic() - started) * 1000)
    doc = parse_doctor_json(proc.stdout or "")
    if doc is not None:
        return {**doc, "elapsed_ms": elapsed_ms}
    combined = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0 and any(marker in combined.lower() for marker in _USAGE_MARKERS):
        raise HTTPException(503, "doctor unavailable")
    return JSONResponse(status_code=502, content={
        "error": "doctor produced no valid JSON",
        "rc": proc.returncode,
        "tail": combined[-_TAIL:],
        "elapsed_ms": elapsed_ms,
    })
