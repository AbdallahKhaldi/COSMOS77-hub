"""Exact agent command lines the hub spawns (one place, so tests can pin them).

Standing posture uses the transport-only ASGI app (`uvicorn <pkg>.net.asgi:app`), the
same artifact the Render deploys run: the endpoint answers 406 around the clock with no
game loop.  A configured run swaps in `<console> serve ...` per the contract, and the
counted variant (SSH CLI only) appends the second arming switch.
"""

from __future__ import annotations

from .config import COP_PORT, THIEF_PORT, Settings
from .runspec import RunSpec

PORTS = {"cop": COP_PORT, "thief": THIEF_PORT}
_PACKAGES = {"cop": "cosmos77_cop", "thief": "cosmos77_thief"}
_CONSOLES = {"cop": "cosmos-cop", "thief": "cosmos-thief"}


def standing_argv(role: str) -> list[str]:
    """Await-mode command: MCP endpoint up (406 to bare GET), nothing playing."""
    return [
        "uv", "run", "uvicorn", f"{_PACKAGES[role]}.net.asgi:app",
        "--host", "127.0.0.1", "--port", str(PORTS[role]),
    ]


def run_argv(role: str, spec: RunSpec, settings: Settings) -> list[str]:
    """Configured-series command for *role* (never counted — see :mod:`runspec`)."""
    gid_b = "cosmos77-mirror" if spec.kind == "selfplay" else spec.opponent_gid
    argv = [
        "uv", "run", _CONSOLES[role], "serve",
        "--port", str(PORTS[role]),
        "--peer-url", spec.peer_url_for(role, PORTS),
        "--gid-a", settings.standing_gids,
        "--gid-b", gid_b,
        "--windows", str(spec.windows),
        "--out", f"runs/{spec.out_stamp}",
        "--events",
    ]
    if spec.kind == "selfplay":
        argv.append("--alternate-labels")
    return argv


def counted_argv(role: str, spec: RunSpec, settings: Settings) -> list[str]:
    """Armed command printed/executed ONLY by the SSH ``cosmos-hub-counted`` CLI."""
    return [*run_argv(role, spec, settings), "--counted"]


def report_dry_run_argv(result_path: str) -> list[str]:
    """Report preview: no ``--send``, no ``--counted`` — structurally friendly-only."""
    return ["uv", "run", "cosmos-cop", "report", result_path]
