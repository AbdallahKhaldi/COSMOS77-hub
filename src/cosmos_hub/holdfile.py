"""The counted hold-file: SSH runs reserve the agent ports; staleness self-heals.

The counted CLI writes the file before arming and removes it in its ``finally``.
A kill -9, a dropped SSH session, or a container restart can orphan it — and bare
existence would then stand the whole arena down forever (agents, relay, demos,
challenges) with nothing in any log saying why.  A hold older than the TTL is
therefore cleared and logged as an abnormal CLI death: a real counted series runs
in minutes, so half a day of hold is abandonment, not play.
"""

from __future__ import annotations

import contextlib
import logging
import time

from .config import Settings

log = logging.getLogger(__name__)
HOLD_TTL_S = 12 * 3600


def hold_active(settings: Settings) -> bool:
    """True while a FRESH counted hold-file exists; stale ones are cleared, loudly."""
    hold = settings.hold_file
    try:
        age = time.time() - hold.stat().st_mtime
    except OSError:
        return False
    if age > HOLD_TTL_S:
        log.warning("clearing STALE counted hold (%.1fh old) — abnormal CLI death", age / 3600)
        with contextlib.suppress(OSError):
            hold.unlink()
        return False
    return True
