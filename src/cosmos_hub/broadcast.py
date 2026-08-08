"""Per-client fan-out queues, one perspective per socket (contract: Event pipeline).

Slow consumers never stall the feed: each client has a bounded asyncio.Queue and the
publisher drops the OLDEST envelope on overflow.  ``publish`` is thread-tolerant: from
a foreign thread it trampolines onto the loop that owns the queues.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict

PERSPECTIVES = ("police", "thief")
QUEUE_SIZE = 256
Envelope = dict[str, object]


class Broadcaster:
    """Registry of live-viewer queues keyed by perspective."""

    def __init__(self) -> None:
        """Start with no clients; the owning loop is captured on first subscribe."""
        self._clients: dict[str, set[asyncio.Queue[Envelope]]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

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

    def _publish(self, envelope: Envelope) -> None:
        perspective = str(envelope.get("perspective", ""))
        for queue in list(self._clients.get(perspective, ())):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):  # racing consumer
                    queue.get_nowait()
            queue.put_nowait(envelope)
