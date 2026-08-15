"""Staged process-group termination shared by the manager (contract: Run lifecycle).

TERM first with a grace window, then KILL: agents flush their event sinks on TERM,
and a settled window's artifacts must never be truncated by an eager KILL.
"""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import subprocess
import time
from typing import IO

log = logging.getLogger(__name__)


def kill_all(procs: dict[str, subprocess.Popen[bytes]], logs: list[IO[bytes]]) -> None:
    """Terminate -> kill every tracked process group, then forget the handles."""
    for name, proc in procs.items():
        for sig, wait_s in ((signal.SIGTERM, 5.0), (signal.SIGKILL, 3.0)):
            if proc.poll() is not None:
                break
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, sig)
            deadline = time.monotonic() + wait_s
            while proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
        log.info("stopped %s pid=%d rc=%s", name, proc.pid, proc.poll())
    procs.clear()
    while logs:
        logs.pop().close()
