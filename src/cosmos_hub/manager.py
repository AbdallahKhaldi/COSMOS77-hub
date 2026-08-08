"""Agent subprocess lifecycle: standing serve <-> configured runs (contract: Run lifecycle).

Two-process rule: the hub only ever SPAWNS the agent repos with ``cwd=<repo>`` — never
imports them.  One active run at a time; on run end both agents return to standing; a
hold-file (SSH counted run) makes the manager stand down until removed.  Public methods
take an RLock: routes call them on the loop, the supervisor ticks in a worker thread.
"""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from typing import IO

from . import argvs
from .config import ROLES, Settings
from .runspec import CountedRefusedError, RunRefusedError, RunSpec

log = logging.getLogger(__name__)
Notify = Callable[[str, dict[str, object]], None]


def spawn_env() -> dict[str, str]:
    """Inherit the hub env (GEMINI_API_KEY etc.) minus VIRTUAL_ENV so uv picks each venv."""
    env = dict(os.environ)
    env.pop("VIRTUAL_ENV", None)
    return env


class Manager:
    """Owns the two agent Popen handles and the standing/running state machine."""

    def __init__(self, settings: Settings, notify: Notify | None = None) -> None:
        """Wire *notify* to receive ``(event, payload)`` status callbacks."""
        self.settings, self.notify = settings, notify or (lambda _e, _p: None)
        self.procs: dict[str, subprocess.Popen[bytes]] = {}
        self.active: RunSpec | None = None
        self._logs: list[IO[bytes]] = []
        self._lock = threading.RLock()

    def _spawn(self, role: str, argv: list[str], tag: str) -> subprocess.Popen[bytes]:
        """Start one agent process, logging its output under the hub data dir."""
        self.settings.logs_dir.mkdir(parents=True, exist_ok=True)
        out = open(self.settings.logs_dir / f"{role}-{tag}.log", "ab")  # noqa: SIM115
        self._logs.append(out)
        proc = subprocess.Popen(
            argv, cwd=str(self.settings.repo(role)), env=spawn_env(),
            stdout=out, stderr=subprocess.STDOUT, start_new_session=True,
        )
        log.info("spawned %s (%s) pid=%d", role, tag, proc.pid)
        return proc

    def _kill_all(self) -> None:
        """Terminate -> kill every tracked process group, then forget the handles."""
        for role, proc in self.procs.items():
            for sig, wait_s in ((signal.SIGTERM, 5.0), (signal.SIGKILL, 3.0)):
                if proc.poll() is not None:
                    break
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, sig)
                deadline = time.monotonic() + wait_s
                while proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
            log.info("stopped %s pid=%d rc=%s", role, proc.pid, proc.poll())
        self.procs.clear()
        for handle in self._logs:
            handle.close()
        self._logs.clear()

    def hold_active(self) -> bool:
        """True while the SSH counted hold-file exists — the manager must stand down."""
        return self.settings.hold_file.exists()

    def start_standing(self) -> None:
        """Put both agents in await mode (406 endpoints up, nothing playing)."""
        with self._lock:
            if self.procs or self.hold_active():
                return
            for role in ROLES:
                self.procs[role] = self._spawn(role, argvs.standing_argv(role), "standing")
            self.notify("status", {"state": "standing"})

    def start_run(self, spec: RunSpec, source: str = "web") -> str:
        """Restart both agents with *spec*'s parameters.  Counted is refused, always."""
        fields = (spec.their_cop_url, spec.their_thief_url, spec.their_single_url,
                  spec.opponent_gid)
        if spec.kind == "counted" or "--counted" in " ".join(filter(None, fields)):
            log.warning("REFUSED counted run attempt from source=%s", source)
            raise CountedRefusedError("counted runs never start from a web-reachable path")
        with self._lock:
            if self.hold_active():
                raise RunRefusedError("counted hold active: agents are reserved for an SSH run")
            if self.active is not None:
                raise RunRefusedError("a run is already active (one at a time)")
            self._kill_all()
            for role in ROLES:
                self.settings.runs_dir(role, spec.out_stamp).mkdir(parents=True, exist_ok=True)
                self.procs[role] = self._spawn(
                    role, argvs.run_argv(role, spec, self.settings), spec.out_stamp
                )
            self.active = spec
        self.notify("run_started", {"run_id": spec.out_stamp, "kind": spec.kind,
                                    "opponent": spec.opponent_gid, "windows": spec.windows})
        return spec.out_stamp

    def stop_run(self) -> bool:
        """Operator stop: kill the active run (if any) and return to standing."""
        with self._lock:
            ended, self.active = self.active, None
            self._kill_all()
            self.start_standing()
        if ended is not None:
            self.notify("run_stopped", {"run_id": ended.out_stamp})
        return ended is not None

    def shutdown(self) -> None:
        """Hub is going down: stop every child, restart nothing."""
        with self._lock:
            self._kill_all()
            self.active = None

    def agents_alive(self) -> dict[str, bool]:
        """Liveness of each tracked agent process (for /api/status)."""
        return {r: (r in self.procs and self.procs[r].poll() is None) for r in ROLES}

    def tick(self) -> None:
        """One supervision step: honor the hold file, reap ended runs, heal standing."""
        with self._lock:
            if self.hold_active():
                if self.procs:
                    log.info("hold file present: releasing ports for the SSH counted run")
                    self._kill_all()
                return
            if self.active is not None:
                if all(p.poll() is not None for p in self.procs.values()):
                    ended, self.active = self.active, None
                    self._kill_all()
                    self.notify("run_ended", {"run_id": ended.out_stamp, "kind": ended.kind})
                    self.start_standing()
                return
            if not self.procs or any(p.poll() is not None for p in self.procs.values()):
                self._kill_all()
                self.start_standing()
