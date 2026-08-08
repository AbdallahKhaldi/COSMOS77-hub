"""RunSpec — the one shape every run-start path funnels through (contract: Run lifecycle).

``kind=counted`` is refused HERE, below every route, so no web-reachable path can arm a
counted run even if a route forgets its own guard.  Counted runs exist only via the SSH
``cosmos-hub-counted`` CLI, which never constructs a RunSpec.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

WEB_KINDS = ("selfplay", "f1", "f2")
GID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_URL_MAX = 300


class CountedRefusedError(Exception):
    """A web-reachable path tried to arm a counted run (hard rail, HTTP 403)."""


class RunRefusedError(Exception):
    """The run cannot start (busy, hold active, or the spec is invalid)."""


@dataclass(frozen=True)
class RunSpec:
    """Parameters of one hub-managed series run."""

    kind: str
    opponent_gid: str
    their_cop_url: str | None = None
    their_thief_url: str | None = None
    their_single_url: str | None = None
    windows: int = 6
    out_stamp: str = ""

    def peer_url_for(self, role: str, own_ports: dict[str, int]) -> str:
        """URL *role*'s agent dials: our cop dials their thief and vice versa."""
        if self.kind == "selfplay":
            other = "thief" if role == "cop" else "cop"
            return f"http://127.0.0.1:{own_ports[other]}/mcp"
        if self.their_single_url:
            return self.their_single_url
        url = self.their_thief_url if role == "cop" else self.their_cop_url
        if not url:
            raise RunRefusedError(f"missing opponent URL for our {role}")
        return url


def fresh_stamp(kind: str, now: float | None = None) -> str:
    """Directory-stamp for ``runs/<stamp>`` — doubles as the public run_id."""
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    return f"{kind}-{stamp}"


def _clean_url(name: str, url: str | None) -> str | None:
    """Length-check an opponent URL (deep validation lives in challenge.py)."""
    if url is None or url == "":
        return None
    if len(url) > _URL_MAX:
        raise RunRefusedError(f"{name} exceeds {_URL_MAX} characters")
    return url


def web_runspec(body: dict[str, object]) -> RunSpec:
    """Build a RunSpec from an untrusted web payload; refuses counted and argv smuggling."""
    for value in body.values():
        if isinstance(value, str) and "--counted" in value:
            raise CountedRefusedError("argv containing --counted is refused on every web path")
    kind = str(body.get("kind", ""))
    if kind == "counted":
        raise CountedRefusedError("kind=counted is refused on every web path")
    if kind not in WEB_KINDS:
        raise RunRefusedError(f"kind must be one of {WEB_KINDS}")
    gid = str(body.get("opponent_gid") or "cosmos77-mirror")
    if not GID_RE.match(gid):
        raise RunRefusedError("opponent_gid must match [A-Za-z0-9._-]{1,64}")
    windows = 1 if kind == "f1" else 6
    if kind == "selfplay":
        windows = int(body.get("windows") or 6)
        if not 1 <= windows <= 6:
            raise RunRefusedError("windows must be 1..6")
    return RunSpec(
        kind=kind,
        opponent_gid=gid,
        their_cop_url=_clean_url("their_cop_url", body.get("their_cop_url")),  # type: ignore[arg-type]
        their_thief_url=_clean_url("their_thief_url", body.get("their_thief_url")),  # type: ignore[arg-type]
        their_single_url=_clean_url("their_single_url", body.get("their_single_url")),  # type: ignore[arg-type]
        windows=windows,
        out_stamp=fresh_stamp(kind),
    )
