"""Per-press variety seeds: selfplay demos vary, league runs stay deterministic."""

from __future__ import annotations

import secrets

from .runspec import RunSpec


def run_seed(spec: RunSpec) -> int | None:
    """Fresh tie-break seed for a demo selfplay; ``None`` keeps legacy determinism."""
    return secrets.randbelow(1_000_000) if spec.kind == "selfplay" else None
