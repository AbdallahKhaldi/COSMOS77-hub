"""Exact subprocess command lines the hub spawns (one place, so tests can pin them).

Standing posture uses the transport-only ASGI app (`uvicorn <pkg>.net.asgi:app`), the
same artifact the Render deploys run: the endpoint answers 406 around the clock with no
game loop.  A configured run swaps in `<console> serve ...` per the contract, and the
counted variant (SSH CLI only) appends the second arming switch.  The window-parity
sparring relay (cop repo script) and the pairing doctor are argv-listed here too —
user input NEVER reaches a shell string.
"""

from __future__ import annotations

import os

from .config import COP_PORT, RELAY_PORT, THIEF_PORT, Settings
from .runspec import RunSpec

PORTS = {"cop": COP_PORT, "thief": THIEF_PORT}
_PACKAGES = {"cop": "cosmos77_cop", "thief": "cosmos77_thief"}
_CONSOLES = {"cop": "cosmos-cop", "thief": "cosmos-thief"}


def spawn_env() -> dict[str, str]:
    """Inherit the hub env (GEMINI_API_KEY etc.) minus VIRTUAL_ENV so uv picks each venv."""
    env = dict(os.environ)
    env.pop("VIRTUAL_ENV", None)
    return env


def standing_argv(role: str) -> list[str]:
    """Await-mode command: MCP endpoint up (406 to bare GET), nothing playing."""
    return [
        "uv", "run", "uvicorn", f"{_PACKAGES[role]}.net.asgi:app",
        "--host", "127.0.0.1", "--port", str(PORTS[role]),
    ]


def relay_argv() -> list[str]:
    """Window-parity relay behind public ``/mcp`` (runs in the cop repo, port 8803)."""
    return [
        "uv", "run", "python", "scripts/sparring_relay.py",
        "--port", str(RELAY_PORT),
        "--odd-url", f"http://127.0.0.1:{COP_PORT}/mcp",
        "--even-url", f"http://127.0.0.1:{THIEF_PORT}/mcp",
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
    if spec.scent_model:
        argv += ["--scent-model", spec.scent_model]
    if spec.kind == "selfplay":
        argv.append("--alternate-labels")
    return argv


def counted_argv(role: str, spec: RunSpec, settings: Settings) -> list[str]:
    """Armed command printed/executed ONLY by the SSH ``cosmos-hub-counted`` CLI."""
    return [*run_argv(role, spec, settings), "--counted"]


def report_dry_run_argv(result_path: str) -> list[str]:
    """Report preview: no ``--send``, no ``--counted`` — structurally friendly-only."""
    return ["uv", "run", "cosmos-cop", "report", result_path]


def doctor_argv(url: str | None = None, cop_url: str | None = None,
                thief_url: str | None = None, gid: str | None = None) -> list[str]:
    """Pairing-doctor command (Track D CLI contract): JSON on stdout, argv list only."""
    argv = ["uv", "run", "cosmos-cop", "doctor", "--json"]
    if url is not None:
        argv += ["--url", url]
    else:
        argv += ["--cop-url", str(cop_url), "--thief-url", str(thief_url)]
    if gid is not None:
        argv += ["--gid", gid]
    return argv
