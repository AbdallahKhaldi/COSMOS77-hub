"""Exact subprocess command lines the hub spawns (one place, so tests can pin them).

Standing posture uses the transport-only ASGI app (`uvicorn <pkg>.net.asgi:app`), the
same artifact the Render deploys run: the endpoint answers 406 around the clock with no
game loop.  A configured run swaps in `<console> serve ...` per the contract, and the
counted variant (SSH CLI only) appends the second arming switch.  The window-parity
sparring relay (cop repo script) and the pairing doctor are argv-listed here too —
user input NEVER reaches a shell string.

Series topology (playbook §1, FIXED): roles alternate each sub-game and the
alphabetically-first gid plays COP on the odd ones.  Against a REAL opponent our two
fixed-role processes therefore split the windows by parity (``--windows-spec``),
write ONE shared absolute ``--out`` on the data volume, and exactly one of them —
the owner of the last window — closes the series (``--no-close`` on the other).
Selfplay keeps per-role dirs and ``--alternate-labels`` (both processes play all
windows in-house); it is the only kind that does.
"""

from __future__ import annotations

import os
from pathlib import Path

from .config import COP_PORT, RELAY_PORT, ROLES, THIEF_PORT, Settings
from .runspec import RunSpec

PORTS = {"cop": COP_PORT, "thief": THIEF_PORT}
_PACKAGES = {"cop": "cosmos77_cop", "thief": "cosmos77_thief"}
_CONSOLES = {"cop": "cosmos-cop", "thief": "cosmos-thief"}


def spawn_env(vary_seed: int | None = None, role: str = "") -> dict[str, str]:
    """Hub env minus VIRTUAL_ENV; a seed arms per-role tie-break variety (demos only)."""
    env = dict(os.environ)
    env.pop("VIRTUAL_ENV", None)
    if vary_seed is not None:
        env["COSMOS_VARY_SEED"] = str(vary_seed + (1 if role == "thief" else 0))
    return env


def standing_argv(role: str) -> list[str]:
    """Await-mode command: MCP endpoint up (406 to bare GET), nothing playing."""
    return [
        "uv", "run", "uvicorn", f"{_PACKAGES[role]}.net.asgi:app",
        "--host", "127.0.0.1", "--port", str(PORTS[role]),
    ]


def parity_windows(spec: RunSpec, settings: Settings) -> dict[str, str]:
    """Per-role window lists: first-sorted gid is COP on odds; our thief owns the rest."""
    ours_first = sorted([settings.standing_gids, spec.opponent_gid])[0] == settings.standing_gids
    odds = ",".join(str(w) for w in range(1, spec.windows + 1, 2))
    evens = ",".join(str(w) for w in range(2, spec.windows + 1, 2))
    return {"cop": odds if ours_first else evens, "thief": evens if ours_first else odds}


def closer_role(spec: RunSpec, settings: Settings) -> str:
    """The role owning the LAST window closes the shared artifact set (writes the result)."""
    split = parity_windows(spec, settings)
    return "cop" if str(spec.windows) in split["cop"].split(",") else "thief"


def active_roles(spec: RunSpec, settings: Settings) -> tuple[str, ...]:
    """Roles that actually play *spec* (an f1 vs a real opponent involves ONE of ours)."""
    if spec.kind == "selfplay":
        return ROLES
    split = parity_windows(spec, settings)
    return tuple(role for role in ROLES if split[role])


def run_out_dirs(spec: RunSpec, settings: Settings) -> list[Path]:
    """Artifact dirs to pre-create: per-role for selfplay, ONE shared vs a real opponent."""
    if spec.kind == "selfplay":
        return [settings.runs_dir(role, spec.out_stamp) for role in ROLES]
    return [settings.shared_runs_dir(spec.out_stamp)]


def run_argv(role: str, spec: RunSpec, settings: Settings) -> list[str]:
    """Configured-series command for *role* (never counted — see :mod:`runspec`)."""
    external = spec.kind != "selfplay"
    gid_b = spec.opponent_gid if external else "cosmos77-mirror"
    out = (settings.shared_runs_dir(spec.out_stamp) if external
           else settings.runs_dir(role, spec.out_stamp))
    argv = [
        "uv", "run", _CONSOLES[role], "serve",
        "--port", str(PORTS[role]),
        "--peer-url", spec.peer_url_for(role, PORTS),
        "--gid-a", settings.standing_gids,
        "--gid-b", gid_b,
        "--windows", str(spec.windows),
        "--out", str(out),
        "--events",
    ]
    if spec.scent_model:
        argv += ["--scent-model", spec.scent_model]
    if not external:
        argv.append("--alternate-labels")
        return argv
    split = parity_windows(spec, settings)[role]
    if not split:
        raise ValueError(f"our {role} owns no window of {spec.out_stamp} (use active_roles)")
    argv += ["--windows-spec", split]
    if role != closer_role(spec, settings):
        argv.append("--no-close")
    return argv


def counted_argv(role: str, spec: RunSpec, settings: Settings) -> list[str]:
    """Armed command printed/executed ONLY by the SSH ``cosmos-hub-counted`` CLI."""
    return [*run_argv(role, spec, settings), "--counted"]


def relay_argv(spec: RunSpec | None = None, settings: Settings | None = None) -> list[str]:
    """Window-parity relay behind public ``/mcp`` (runs in the cop repo, port 8803).

    For a real-opponent run the odd/even upstreams follow the SAME gid-sort parity as
    the agents' ``--windows-spec``; standing/selfplay keeps the documented default
    (odd → cop).
    """
    odd_role = "cop"
    if spec is not None and settings is not None and spec.kind != "selfplay":
        split = parity_windows(spec, settings)
        odd_role = "cop" if "1" in split["cop"].split(",") else "thief"
    even_role = "thief" if odd_role == "cop" else "cop"
    return [
        "uv", "run", "python", "scripts/sparring_relay.py",
        "--port", str(RELAY_PORT),
        "--odd-url", f"http://127.0.0.1:{PORTS[odd_role]}/mcp",
        "--even-url", f"http://127.0.0.1:{PORTS[even_role]}/mcp",
    ]


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
