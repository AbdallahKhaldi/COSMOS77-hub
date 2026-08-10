"""Sandbox rules for single-player games (never for league play).

A league game runs the CONSTITUTION: the fourteen signed terms both teams hash
and sign, where a single changed value is a refused handshake and a rules
violation.  A single-player game is ours alone, so visitors may reshape the
board — rounds, size, move limit, barrier quota — and both of our agents load
the SAME generated file, so the pre-game signature still matches on the wire.
Every field is clamped here; nothing a visitor sends reaches a config unchecked.
"""

from __future__ import annotations

import json
import random
import secrets
from pathlib import Path
from typing import Any

from .config import Settings

# (floor, ceiling). The floors are Appendix F: a MINIMUM parameter may be raised
# by agreement but never lowered, and the agents' own validator refuses anything
# else — so the sandbox can only ever make a game BIGGER, never weaker. Scoring,
# the pheromone field and the move set are FIXED and are not offered at all.
LIMITS: dict[str, tuple[int, int]] = {
    "windows": (1, 6),        # a league field, not an App. F parameter
    "grid": (7, 11),          # App. F minimum 7
    "max_moves": (35, 80),    # App. F minimum 35
    "max_barriers": (14, 30), # App. F minimum 14
    "dwell_ms": (120, 2000),  # presentation only, never in the config
}


def clamp(name: str, value: object, fallback: int) -> int:
    """Coerce one visitor-supplied number into its allowed band."""
    low, high = LIMITS[name]
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def wanted(body: dict[str, Any], base: dict[str, Any]) -> dict[str, int]:
    """Read the requested sandbox rules, each clamped, defaulting to the constitution."""
    board = base["board_and_agents"]
    movement = base["movement_and_barriers"]
    league = base["network_and_league"]
    return {
        "windows": clamp("windows", body.get("windows"), 1),
        "grid": clamp("grid", body.get("grid"), board["grid_size"]),
        "max_moves": clamp("max_moves", body.get("max_moves"), movement["max_moves"]),
        "max_barriers": clamp("max_barriers", body.get("max_barriers"),
                              movement["max_barriers"]),
        "dwell_ms": clamp("dwell_ms", body.get("dwell_ms"), 700),
        "_num_games": league["num_games"],
    }


def start_cells(grid: int, rng: random.Random) -> tuple[list[int], list[int]]:
    """Two legal opening cells, at least ``grid - 1`` apart, drawn fresh per game.

    The constitution opens the cop in a corner and the thief dead centre.  That is a
    fine duel -- but it is the SAME duel every time, and with both sides running our
    own deterministic Python it produced the same chase and the same 5-10 survival on
    every press.  Start cells are not an Appendix F FIXED parameter (those are the
    scoring, the pheromone field, the move set, the axis and the agent count), and
    both of our agents load this one generated file, so the pre-game signature still
    matches on the wire.  The floor is the constitution's OWN opening distance --
    ``|0-3| + |0-3| == 6`` on a 7x7, i.e. ``grid - 1`` -- so a varied game is never a
    softer one for either side.
    """
    cells = [[row, col] for row in range(grid) for col in range(grid)]
    gap = grid - 1
    pairs = [(cop, thief) for cop in cells for thief in cells
             if abs(cop[0] - thief[0]) + abs(cop[1] - thief[1]) >= gap]
    return rng.choice(pairs)


def build_config(base: dict[str, Any], rules: dict[str, int],
                 rng: random.Random | None = None) -> dict[str, Any]:
    """The constitution with the sandbox overrides applied and fresh legal starts."""
    cfg = json.loads(json.dumps(base))  # deep copy: never mutate the agreed file
    grid = rules["grid"]
    board = cfg["board_and_agents"]
    board["grid_size"] = grid
    board["cop_start"], board["thief_start"] = start_cells(
        grid, rng if rng is not None else random.Random(secrets.randbits(64))
    )
    movement = cfg["movement_and_barriers"]
    movement["max_moves"] = rules["max_moves"]
    movement["survival_threshold"] = rules["max_moves"]
    movement["max_barriers"] = rules["max_barriers"]
    cfg["network_and_league"]["num_games"] = rules["windows"]
    cfg["agreed_between"] = ["cosmos77", "cosmos77-mirror"]
    return cfg


def write_config(settings: Settings, stamp: str, cfg: dict[str, Any]) -> Path:
    """Persist the generated rules where BOTH agents read the identical bytes."""
    path = settings.data_dir / "configs" / f"{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def league_config(settings: Settings) -> dict[str, Any]:
    """The agreed constitution as shipped in the cop repo (the league baseline)."""
    with (settings.repo("cop") / "config" / "game.json").open(encoding="utf-8") as handle:
        return json.load(handle)
