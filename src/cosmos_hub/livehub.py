"""LiveHub: manager notifications -> tailer lifecycle -> broadcaster envelopes.

Split from :mod:`cosmos_hub.events` (which keeps the RunTailer) purely for the
150-line file rail; together they are the Event pipeline contract.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from typing import Any

from .broadcast import PERSPECTIVES, Broadcaster
from .config import Settings
from .envelopes import EnvelopeLog
from .events import RunTailer

log = logging.getLogger(__name__)


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
            self.broadcaster.clear_history()
            self.begin_run(str(payload["run_id"]))
            self.log.emit_both("status", {"state": "running", **payload})
            return
        if event in ("run_ended", "run_stopped"):
            self.log.emit_both("status", {"state": "standing", **payload})
            self.broadcaster.mark_settled()  # replayable to late viewers only briefly
            self.request_stop()
            self._reset_standing(payload)
            if self.on_settled is not None:
                with contextlib.suppress(Exception):
                    self.on_settled(str(payload.get("run_id", "")))
            return
        self.log.emit_both("status", payload)

    def _reset_standing(self, payload: dict[str, Any]) -> None:
        """Fresh standing log: late connections snapshot NO dead-run view/windows/final.

        Seeded directly, never emit()ed: a broadcast "standing" envelope would wipe
        connected clients' timelines mid-outro (they keep draining the old log).
        """
        standing = EnvelopeLog(self.broadcaster, "standing")
        status = {"state": "standing", **{k: v for k, v in payload.items() if k != "run_id"}}
        for perspective in PERSPECTIVES:
            standing.snapshots[perspective]["status"] = dict(status)
        self.log = standing

    def begin_run(self, run_id: str) -> None:
        """Fresh envelope log (seq restarts) and a tailer over every candidate run dir."""
        self.request_stop()
        self.log = EnvelopeLog(self.broadcaster, run_id)
        tailer = RunTailer(self.settings.run_dirs(run_id), self.log)
        try:
            self._stop = asyncio.Event()
            self._task = asyncio.get_running_loop().create_task(tailer.run(self._stop))
            log.info("tailer running for %s", run_id)
        except RuntimeError:  # no loop (unit tests) — envelopes still flow, no tailer
            log.warning("no running loop: tailer skipped for %s", run_id)
            self._stop, self._task = None, None

    def request_stop(self) -> None:
        """Ask the current tailer to drain and finish."""
        if self._stop is not None:
            self._stop.set()
