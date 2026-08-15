"""Subprocess lifecycle: standing serve <-> configured runs (contract: Run lifecycle).

Two-process rule: the hub only SPAWNS the agent repos (``cwd=<repo>``), never imports
them.  One run at a time; a hold-file (SSH counted) stands the manager down; the /mcp
relay is healed like the agents.  RLock everywhere: routes call on the loop, the
supervisor ticks in a worker thread.
"""

from __future__ import annotations

import logging
import subprocess
import threading
from collections.abc import Callable

from . import argvs, holdfile, procs, seeds
from .config import RELAY, ROLES, Settings
from .runspec import CountedRefusedError, RunRefusedError, RunSpec

log = logging.getLogger(__name__)
Notify = Callable[[str, dict[str, object]], None]


class Manager:
    """Owns the agent + relay Popen handles and the standing/running state machine."""

    def __init__(self, settings: Settings, notify: Notify | None = None) -> None:
        """Wire *notify* to receive ``(event, payload)`` status callbacks."""
        self.settings, self.notify = settings, notify or (lambda _e, _p: None)
        self.procs: dict[str, subprocess.Popen[bytes]] = {}
        self.active: RunSpec | None = None
        self.active_source = ""  # who started the run: demo | challenge | admin
        self._logs, self._lock = [], threading.RLock()  # open log handles + state lock

    def _spawn(self, name: str, argv: list[str], tag: str, vary_seed: int | None = None,
               dwell_ms: int | None = None) -> subprocess.Popen[bytes]:
        """Start one subprocess; env carries seed/dwell/origin + the volume ledger."""
        self.settings.logs_dir.mkdir(parents=True, exist_ok=True)
        self._logs.append(out := open(self.settings.logs_dir / f"{name}-{tag}.log", "ab"))  # noqa: SIM115
        env = seeds.spawn_env(vary_seed, name, dwell_ms, self.settings.public_url,
                              str(self.settings.ledger_file))
        proc = subprocess.Popen(argv, cwd=str(self.settings.repo(name)), env=env, stdout=out,
                                stderr=subprocess.STDOUT, start_new_session=True)
        log.info("spawned %s (%s) pid=%d", name, tag, proc.pid)
        return proc

    def _kill_all(self) -> None:
        """Staged TERM->KILL of every tracked process group (procs.kill_all)."""
        procs.kill_all(self.procs, self._logs)

    def hold_active(self) -> bool:
        """A FRESH counted hold-file (stale ones self-heal in holdfile.py, loudly)."""
        return holdfile.hold_active(self.settings)

    def start_standing(self) -> None:
        """Put agents in await mode (406 endpoints up) and the relay behind /mcp."""
        with self._lock:
            if self.procs or self.hold_active():
                return
            for role in ROLES:
                argv = argvs.standing_argv(role, self.settings)
                self.procs[role] = self._spawn(role, argv, "standing")
            self.procs[RELAY] = self._spawn(RELAY, argvs.relay_argv(self.settings), "standing")
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
            for out in argvs.run_out_dirs(spec, self.settings):
                out.mkdir(parents=True, exist_ok=True)
            self.active_source = source
            vary, dwell = seeds.run_seed(spec), seeds.turn_delay_ms(spec)
            for role in argvs.active_roles(spec, self.settings):
                self.procs[role] = self._spawn(role, argvs.run_argv(role, spec, self.settings),
                                               spec.out_stamp, vary_seed=vary, dwell_ms=dwell)
            self.procs[RELAY] = self._spawn(RELAY, argvs.relay_argv(self.settings, spec),
                                            spec.out_stamp)
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
        """Liveness of every tracked subprocess — both agents plus the relay."""
        return {n: n in self.procs and self.procs[n].poll() is None for n in (*ROLES, RELAY)}

    def tick(self) -> None:
        """One supervision step: honor the hold file, reap ended runs, heal standing."""
        with self._lock:
            if self.hold_active():
                if self.procs:  # a killed web run is OVER — never resumable post-hold
                    log.info("hold file present: releasing ports for the SSH counted run")
                    ended, self.active = self.active, None
                    self._kill_all()
                    if ended is not None:
                        self.notify("run_stopped", {"run_id": ended.out_stamp})
                return
            if self.active is not None:
                if all(self.procs[r].poll() is not None for r in ROLES if r in self.procs):
                    ended, self.active = self.active, None
                    self._kill_all()
                    self.notify("run_ended", {"run_id": ended.out_stamp, "kind": ended.kind})
                    self.start_standing()
                elif RELAY not in self.procs or self.procs[RELAY].poll() is not None:
                    self.procs[RELAY] = self._spawn(
                        RELAY, argvs.relay_argv(self.settings, self.active),
                        self.active.out_stamp)
                return
            if not self.procs or any(p.poll() is not None for p in self.procs.values()):
                self._kill_all()
                self.start_standing()
