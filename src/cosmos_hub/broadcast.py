"""Per-client fan-out queues, one perspective per socket (contract: Event pipeline).

Slow consumers never stall the feed: each client has a bounded asyncio.Queue and the
publisher drops the OLDEST envelope on overflow.  ``publish`` is thread-tolerant: from
a foreign thread it trampolines onto the loop that owns the queues.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict, deque
from time import monotonic

PERSPECTIVES = ("police", "thief")
QUEUE_SIZE = 256
HISTORY_SIZE = 2000
# How long a SETTLED run stays replayable to a brand-new viewer. Long enough for the
# socket of whoever pressed START (a fast selfplay settles in ~2s), short enough that
# a visitor arriving later is never shown a finished game as if it were live.
SETTLED_GRACE_S = 25.0
Envelope = dict[str, object]


class Broadcaster:
    """Registry of live-viewer queues keyed by perspective."""

    def __init__(self) -> None:
        """Start with no clients; the owning loop is captured on first subscribe."""
        self._clients: dict[str, set[asyncio.Queue[Envelope]]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None
        self.history: deque[Envelope] = deque(maxlen=HISTORY_SIZE)
        self._settled_at: float | None = None

    def subscribe(self, perspective: str) -> asyncio.Queue[Envelope]:
        """Register a new client queue for *perspective* (loop-thread only)."""
        self._loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Envelope] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._clients[perspective].add(queue)
        return queue

    def unsubscribe(self, perspective: str, queue: asyncio.Queue[Envelope]) -> None:
        """Drop a client queue (idempotent)."""
        self._clients[perspective].discard(queue)

    def client_count(self) -> int:
        """Total connected live viewers across both perspectives."""
        return sum(len(qs) for qs in self._clients.values())

    def publish(self, envelope: Envelope) -> None:
        """Fan *envelope* out to its perspective's queues, dropping oldest on overflow."""
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if self._loop is not None and running is not self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._publish, envelope)
            return
        self._publish(envelope)

    def history_for(self, perspective: str) -> list[Envelope]:
        """Retained envelopes for one perspective — only while they are still NEWS.

        History exists for one reason: a selfplay can settle in ~2s, faster than the
        socket of the very person who pressed START, and they must still see their
        game.  It must NOT outlive that.  Retained forever, every later page load
        replays the last finished game labelled LIVE -- an arena that performs a
        recording of itself, which is indistinguishable from a video on loop and is
        exactly the thing this project must never do.  After the grace window a new
        viewer gets the standing snapshot instead, and an idle arena says it is idle.
        """
        if self._settled_at is not None and monotonic() - self._settled_at > SETTLED_GRACE_S:
            return []
        return [e for e in self.history if e.get("perspective") == perspective]

    def clear_history(self) -> None:
        """A new run started: viewers must never see two runs stitched together."""
        self.history.clear()
        self._settled_at = None

    def mark_settled(self) -> None:
        """The run ended: history stays replayable only for the grace window."""
        self._settled_at = monotonic()

    def _publish(self, envelope: Envelope) -> None:
        perspective = str(envelope.get("perspective", ""))
        self.history.append(envelope)
        for queue in list(self._clients.get(perspective, ())):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):  # racing consumer
                    queue.get_nowait()
            queue.put_nowait(envelope)
