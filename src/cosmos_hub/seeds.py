"""Per-run runtime knobs: the spawn environment, variety seeds and spectator pacing.

Demo selfplays vary their tie-breaks and dwell between views so the feed is
genuinely live; league runs get neither — they stay deterministic and full speed.
"""

from __future__ import annotations

import os
import secrets

from .config import ROLES
from .runspec import RunSpec

SPECTATOR_DWELL_MS = 700  # per view: roughly one followable move per second


def run_seed(spec: RunSpec) -> int | None:
    """Fresh tie-break seed for a demo selfplay; ``None`` keeps legacy determinism."""
    return secrets.randbelow(1_000_000) if spec.kind == "selfplay" else None


def turn_delay_ms(spec: RunSpec) -> int | None:
    """Spectator dwell for public selfplay demos; league runs always play full speed."""
    if spec.kind != "selfplay":
        return None
    return spec.dwell_ms or SPECTATOR_DWELL_MS


def public_mcp_url(public_url: str, role: str) -> str | None:
    """The address an opponent can ACTUALLY reach this role's MCP server on.

    An agent that cannot see the hub in front of it declares ``127.0.0.1:<port>``,
    which is true of its own socket and useless to anyone else -- and that string is
    sealed into the pre-game declaration a counted opponent keeps.  The hub knows its
    own public origin and the proxy path it publishes each role on, so it states the
    reachable one instead of the loopback one.
    """
    if role not in ROLES or not public_url:
        return None
    return f"{public_url.rstrip('/')}/{role}/mcp"


def spawn_env(vary_seed: int | None = None, role: str = "",
              turn_delay_ms: int | None = None,
              public_url: str = "", ledger_file: str = "") -> dict[str, str]:
    """Hub env minus VIRTUAL_ENV; seed = per-role variety, dwell = spectator pacing.

    ``ledger_file`` points the agents' rule-52 ledger at the volume twin so runtime
    advances survive redeploys WITHOUT touching the repo working tree (the counted
    arming gate requires that tree clean).
    """
    env = dict(os.environ)
    env.pop("VIRTUAL_ENV", None)
    if ledger_file:
        env["COSMOS_LEDGER_FILE"] = ledger_file
    if vary_seed is not None:
        env["COSMOS_VARY_SEED"] = str(vary_seed + (1 if role == "thief" else 0))
    if turn_delay_ms:
        env["COSMOS_TURN_DELAY_MS"] = str(turn_delay_ms)
    if (reachable := public_mcp_url(public_url, role)) is not None:
        env["COSMOS_PUBLIC_MCP_URL"] = reachable
    return env
