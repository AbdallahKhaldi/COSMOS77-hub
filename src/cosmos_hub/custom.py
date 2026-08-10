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


def build_config(base: dict[str, Any], rules: dict[str, int]) -> dict[str, Any]:
    """The constitution with the sandbox overrides applied and the starts made legal."""
    cfg = json.loads(json.dumps(base))  # deep copy: never mutate the agreed file
    grid = rules["grid"]
    board = cfg["board_and_agents"]
    board["grid_size"] = grid
    board["cop_start"] = [0, 0]
    board["thief_start"] = [grid // 2, grid // 2]  # centre, always on the board
    movement = cfg["movement_and_barriers"]
    movement["max_moves"] = rules["max_moves"]
    movement["survival_threshold"] = rules["max_moves"]
    movement["max_barriers"] = rules["max_barriers"]
    cfg["network_and_league"]["num_games"] = rules["windows"]
    cfg["agreed_between"] = ["cosmos77", "cosmos77-mirror"]
    return cfg


def is_default(rules: dict[str, int], base: dict[str, Any]) -> bool:
    """True when the sandbox asks for nothing the constitution does not already say."""
    board, movement = base["board_and_agents"], base["movement_and_barriers"]
    return (rules["grid"] == board["grid_size"]
            and rules["max_moves"] == movement["max_moves"]
            and rules["max_barriers"] == movement["max_barriers"])


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
