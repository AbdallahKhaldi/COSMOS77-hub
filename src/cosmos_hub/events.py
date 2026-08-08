"""Tail both repos' run artifacts into viewer envelopes (contract: Event pipeline).

Each side of a run writes ``runs/<stamp>/`` inside its OWN repo: ``events.jsonl``
(one line per on_view callback), ``log_*_gNN.json`` when a window settles and
``result_*.json`` when the series ends.  The tailer polls both directories, composes
seq-stamped envelopes and never rewrites an artifact (read-only bytes).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .broadcast import PERSPECTIVES, Broadcaster
from .config import ROLES, Settings
from .envelopes import EnvelopeLog, series_end_payload, view_payload, window_end_payload

log = logging.getLogger(__name__)


class _Side:
    """Cursor state for one repo's run directory."""

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


class LiveHub:
    """Glue: manager notifications -> tailer lifecycle -> broadcaster envelopes."""

    def __init__(self, settings: Settings, broadcaster: Broadcaster | None = None) -> None:
        """Start in standing posture with an empty envelope log."""
        self.settings = settings
        self.broadcaster = broadcaster or Broadcaster()
        self.log = EnvelopeLog(self.broadcaster, "standing")
        self.on_settled: Callable[[str], None] | None = None
        self._stop: asyncio.Event | None = None
        self._task: asyncio.Task[None] | None = None

    def notify(self, event: str, payload: dict[str, Any]) -> None:
        """Manager callback (loop thread): drive envelopes and the tailer."""
        if event == "run_started":
            self.begin_run(str(payload["run_id"]))
            self.log.emit_both("status", {"state": "running", **payload})
            return
        if event in ("run_ended", "run_stopped"):
            self.log.emit_both("status", {"state": "standing", **payload})
            self.request_stop()
            if self.on_settled is not None:
                with contextlib.suppress(Exception):
                    self.on_settled(str(payload.get("run_id", "")))
            return
        self.log.emit_both("status", payload)

    def begin_run(self, run_id: str) -> None:
        """Fresh envelope log (seq restarts) and a tailer over both repos' run dirs."""
        self.request_stop()
        self.log = EnvelopeLog(self.broadcaster, run_id)
        dirs = [self.settings.runs_dir(role, run_id) for role in ROLES]
        tailer = RunTailer(dirs, self.log)
        try:
            self._stop = asyncio.Event()
            self._task = asyncio.get_running_loop().create_task(tailer.run(self._stop))
        except RuntimeError:  # no loop (unit tests) — envelopes still flow, no tailer
            self._stop, self._task = None, None

    def request_stop(self) -> None:
        """Ask the current tailer to drain and finish."""
        if self._stop is not None:
            self._stop.set()
