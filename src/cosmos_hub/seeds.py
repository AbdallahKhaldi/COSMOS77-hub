"""Per-run runtime knobs: the spawn environment, variety seeds and spectator pacing.

Demo selfplays vary their tie-breaks and dwell between views so the feed is
genuinely live; league runs get neither — they stay deterministic and full speed.
"""

from __future__ import annotations

import os
import secrets

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


def spawn_env(vary_seed: int | None = None, role: str = "",
              turn_delay_ms: int | None = None) -> dict[str, str]:
    """Hub env minus VIRTUAL_ENV; seed = per-role variety, dwell = spectator pacing."""
    env = dict(os.environ)
    env.pop("VIRTUAL_ENV", None)
    if vary_seed is not None:
        env["COSMOS_VARY_SEED"] = str(vary_seed + (1 if role == "thief" else 0))
    if turn_delay_ms:
        env["COSMOS_TURN_DELAY_MS"] = str(turn_delay_ms)
    return env
