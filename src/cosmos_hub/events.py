"""Tail run artifacts into viewer envelopes (contract: Event pipeline).

Runs write under ``data_dir/runs`` (one shared dir vs a real opponent, per-role dirs
for selfplay): ``events.jsonl`` per on_view line, ``log_*_gNN.json`` per settled
window, ``result_*.json`` at series end.  The tailer polls every candidate dir,
composes seq-stamped envelopes and never rewrites an artifact (read-only bytes).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from pathlib import Path
from typing import Any

from .broadcast import PERSPECTIVES
from .envelopes import EnvelopeLog, series_end_payload, view_payload, window_end_payload

log = logging.getLogger(__name__)


class _Side:
    """Cursor state for one run directory."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.offset = 0
        self.seen: set[str] = set()


class RunTailer:
    """Polls the two run directories and emits view / window_end / series_end."""

    def __init__(self, dirs: list[Path], envelope_log: EnvelopeLog, poll_s: float = 0.25) -> None:
        """Tail *dirs* (cop repo dir, thief repo dir) into *envelope_log*."""
        self.sides = [_Side(d) for d in dirs]
        self.log = envelope_log
        self.poll_s = poll_s
        self.series_done = False

    def _sweep_events(self, side: _Side) -> None:
        path = side.directory / "events.jsonl"
        if not path.is_file() or path.stat().st_size <= side.offset:
            return
        with path.open("rb") as handle:
            handle.seek(side.offset)
            chunk = handle.read()
        complete = chunk.rfind(b"\n") + 1
        side.offset += complete
        for raw in chunk[:complete].splitlines():
            with contextlib.suppress(json.JSONDecodeError, UnicodeDecodeError):
                line = json.loads(raw)
                role = line.get("role") if isinstance(line, dict) else None
                if role in PERSPECTIVES:
                    self.log.emit("view", role, view_payload(line))

    def _sweep_artifacts(self, side: _Side) -> None:
        for path in sorted(side.directory.glob("log_*_g*.json")):
            if path.name in side.seen:
                continue
            doc = _read_json(path)
            if doc is None:
                continue
            side.seen.add(path.name)
            perspective = doc.get("summary", {}).get("my_role")
            if perspective in PERSPECTIVES:
                self.log.emit("window_end", perspective, window_end_payload(doc))
        for path in sorted(side.directory.glob("result_*.json")):
            if path.name in side.seen or self.series_done:
                continue
            doc = _read_json(path)
            if doc is None:
                continue
            side.seen.add(path.name)
            self.series_done = True
            self.log.emit_both("series_end", series_end_payload(doc))

    def sweep(self) -> None:
        """One pass over both directories (also used as the final drain)."""
        for side in self.sides:
            self._sweep_events(side)
            self._sweep_artifacts(side)

    async def run(self, stop: asyncio.Event) -> None:
        """Poll until *stop* is set, then drain once more so nothing is lost."""
        while not stop.is_set():
            self.sweep()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), self.poll_s)
        self.sweep()


def _read_json(path: Path) -> dict[str, Any] | None:
    """Load a settled artifact; None while the writer is mid-flight."""
    try:
        with path.open("r", encoding="utf-8") as handle:
            doc = json.load(handle)
        return doc if isinstance(doc, dict) else None
    except (json.JSONDecodeError, OSError):
        return None
