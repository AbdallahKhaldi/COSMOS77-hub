"""Public challenge endpoint — no auth, hard rate limits (contract: Run lifecycle).

Anyone may POST https URLs and get a friendly run (f1 = 1 window, f2 = 6).  Rails:
https-only, public-resolving hostnames (SSRF guard), URLs <= 300 chars, one concurrent
run, 10/day, 90 s cooldown.  In-memory state by design.  An installed pairing config
(pairings.py) replaces our constitution for that opponent automatically.
"""

from __future__ import annotations

import asyncio
import dataclasses
import ipaddress
import socket
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request

from . import pairings
from .manager import Manager
from .runspec import (
    GID_RE,
    CountedRefusedError,
    RunRefusedError,
    RunSpec,
    clean_scent_model,
    fresh_stamp,
)

router = APIRouter()
Resolver = Callable[[str], list[str]]
URL_MAX = 300
DAILY_LIMIT = 10
COOLDOWN_S = 90.0


def default_resolver(host: str) -> list[str]:
    """All addresses *host* resolves to (both families)."""
    infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    return [str(info[4][0]) for info in infos]


def check_url(url: str, resolver: Resolver = default_resolver) -> None:
    """Reject non-public/https URLs (TOCTOU boundary documented in :mod:`cosmos_hub.doctor`)."""
    if len(url) > URL_MAX:
        raise HTTPException(422, f"URL longer than {URL_MAX} characters")
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise HTTPException(422, "only https:// opponent URLs are accepted")
    host = parts.hostname
    if not host:
        raise HTTPException(422, "URL has no hostname")
    try:
        addresses = resolver(host)
    except OSError as exc:
        raise HTTPException(422, f"hostname does not resolve: {host}") from exc
    for address in addresses:
        try:
            if not ipaddress.ip_address(address.split("%")[0]).is_global:
                raise HTTPException(422, "private, loopback and reserved addresses are refused")
        except ValueError as exc:
            raise HTTPException(422, "hostname resolved to a non-IP address") from exc


class ChallengeGate:
    """In-memory cooldown + daily quota (clock injectable for tests)."""

    def __init__(self, clock: Callable[[], float] = time.time,
                 cooldown_s: float = COOLDOWN_S, daily: int = DAILY_LIMIT) -> None:
        """Track the last start and the per-UTC-day counter."""
        self.clock, self.cooldown_s, self.daily = clock, cooldown_s, daily
        self.last_start, self.day, self.count = float("-inf"), "", 0

    def admit(self) -> None:
        """Raise 429 when the cooldown or the daily quota says no."""
        now = self.clock()
        if now - self.last_start < self.cooldown_s:
            wait = int(self.cooldown_s - (now - self.last_start)) + 1
            raise HTTPException(429, f"cooldown: try again in {wait}s")
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        if day != self.day:
            self.day, self.count = day, 0
        if self.count >= self.daily:
            raise HTTPException(429, f"daily limit reached ({self.daily}/day)")

    def note_started(self) -> None:
        """Record a successful start against the quota."""
        self.last_start = self.clock()
        self.count += 1


def build_spec(body: dict[str, Any], resolver: Resolver) -> RunSpec:
    """Validate the public payload into a friendly RunSpec (f1 or f2 only)."""
    kind = str(body.get("kind", "f1"))
    if kind not in ("f1", "f2"):
        raise HTTPException(403, "only f1 and f2 challenges are accepted here")
    single = str(body.get("their_single_url") or "") or None
    cop = str(body.get("their_cop_url") or "") or None
    thief = str(body.get("their_thief_url") or "") or None
    if single or (cop and thief):
        for url in filter(None, (single, cop, thief)):
            check_url(url, resolver)
    else:
        raise HTTPException(422, "provide their_cop_url + their_thief_url, or their_single_url")
    try:
        return RunSpec(
            kind=kind, opponent_gid=_gid(body),
            their_cop_url=cop, their_thief_url=thief, their_single_url=single,
            scent_model=clean_scent_model(body.get("scent_model")),
            windows=1 if kind == "f1" else 6, out_stamp=fresh_stamp(kind),
        )
    except RunRefusedError as exc:
        raise HTTPException(422, str(exc)) from exc


def _gid(body: dict[str, Any]) -> str:
    gid = str(body.get("opponent_gid") or "challenger")
    if not GID_RE.match(gid):
        raise HTTPException(422, "opponent_gid must match [A-Za-z0-9._-]{1,64}")
    return gid


@router.post("/api/challenge")
async def post_challenge(request: Request) -> dict[str, str]:
    """Start a public friendly run against the caller's agents."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "body must be a JSON object")
    if any(isinstance(v, str) and "--counted" in v for v in body.values()):
        raise HTTPException(403, "counted is never web-reachable")
    manager: Manager = request.app.state.manager
    if manager.active is not None:
        raise HTTPException(409, "a run is already live — watch it, then challenge again")
    gate: ChallengeGate = request.app.state.challenge_gate
    gate.admit()
    spec = await asyncio.to_thread(build_spec, body,  # DNS off the loop
                                   request.app.state.challenge_resolver)
    if installed := pairings.active_pairing_config(request.app.state.settings, spec.opponent_gid):
        spec = dataclasses.replace(spec, config_path=installed)  # their agreed file, not ours
    try:
        run_id = manager.start_run(spec, source="challenge")
    except CountedRefusedError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RunRefusedError as exc:
        raise HTTPException(409, str(exc)) from exc
    gate.note_started()
    return {"run_id": run_id, "watch_url": f"/?run={run_id}"}
