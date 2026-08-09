"""``cosmos-hub-counted`` — the ONLY way a counted run starts on the hub (SSH terminal).

No web request can reach this: it is a console script that refuses non-TTY stdin,
prints the exact armed commands, and executes them only after the operator types
``ARM COUNTED``.  While it runs, a hold-file keeps the hub manager off the agent
ports; because the manager also stands its relay down, THIS CLI spawns the
window-parity relay itself (odd/even matched to the gid-sort split), so the public
single URL ``/mcp`` keeps working for the opponent — or hand them the per-role URLs
printed below, matched to the same parity.  The series is ONE role-alternating
6-sub-game game: both agents share one absolute ``--out`` on the data volume, split
the windows by parity (``--windows-spec``) and exactly one closes.  Reporting stays
a separate deliberate step: ONE report against the single shared result, printed,
never auto-sent.
"""

from __future__ import annotations

import argparse
import contextlib
import shlex
import socket
import subprocess
import sys
import time

from . import argvs, config, persist, seeds
from .runspec import GID_RE, RunSpec

CONFIRMATION = "ARM COUNTED"
_PORT_WAIT_S = 90.0


def _port_busy(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


def _wait_ports_free(ports: list[int], deadline_s: float) -> bool:
    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        if not any(_port_busy(p) for p in ports):
            return True
        time.sleep(1.0)
    return False


def _parse(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="cosmos-hub-counted",
        description="Arm and run ONE counted series from an SSH terminal.",
    )
    parser.add_argument("--opponent-gid", required=True)
    parser.add_argument("--their-cop-url", default=None)
    parser.add_argument("--their-thief-url", default=None)
    parser.add_argument("--their-single-url", default=None)
    parser.add_argument("--windows", type=int, default=6)
    parser.add_argument("--stamp", default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Entry point; returns a process exit code."""
    if not sys.stdin.isatty():
        print("REFUSED: cosmos-hub-counted requires an interactive terminal (SSH in).",
              file=sys.stderr)
        return 2
    args = _parse(argv)
    if not GID_RE.match(args.opponent_gid):
        print("REFUSED: opponent gid must match [A-Za-z0-9._-]{1,64}", file=sys.stderr)
        return 2
    settings = config.load()
    spec = RunSpec(
        kind="counted", opponent_gid=args.opponent_gid,
        their_cop_url=args.their_cop_url, their_thief_url=args.their_thief_url,
        their_single_url=args.their_single_url, windows=args.windows,
        out_stamp=args.stamp or f"counted-{time.strftime('%Y%m%d-%H%M%S')}",
    )
    roles = argvs.active_roles(spec, settings)
    commands = {role: argvs.counted_argv(role, spec, settings) for role in roles}
    split = argvs.parity_windows(spec, settings)
    shared_out = settings.shared_runs_dir(spec.out_stamp)
    print("== COUNTED RUN — the following ARMED commands will be executed ==")
    for role, command in commands.items():
        print(f"  (cwd {settings.repo(role)})\n  $ {shlex.join(command)}")
    print(f"Topology (gid sort {sorted([settings.standing_gids, spec.opponent_gid])}): "
          f"our cop plays windows [{split['cop'] or '-'}], our thief [{split['thief'] or '-'}]; "
          f"the {argvs.closer_role(spec, settings)} closes; shared out {shared_out}")
    print("Opponent URLs: single /mcp (parity relay, spawned below) or per-role "
          "/cop/mcp + /thief/mcp matched to the windows above.")
    print("Prerequisite: config counted=true in both repos (double arming, rules 37-38).")
    try:
        typed = input(f'Type "{CONFIRMATION}" to proceed: ')
    except EOFError:
        typed = ""
    if typed.strip() != CONFIRMATION:
        print("aborted: confirmation not given")
        return 3
    hold = settings.hold_file
    hold.parent.mkdir(parents=True, exist_ok=True)
    hold.write_text(f"counted {spec.out_stamp} {time.time()}\n", encoding="utf-8")
    shared_out.mkdir(parents=True, exist_ok=True)
    procs: list[subprocess.Popen[bytes]] = []
    relay: subprocess.Popen[bytes] | None = None
    try:
        ports = [*argvs.PORTS.values(), config.RELAY_PORT]
        print(f"waiting for the hub to release ports {ports} (hold file set) ...")
        if not _wait_ports_free(ports, _PORT_WAIT_S):
            print("REFUSED: agent ports still busy — is the hub honoring the hold file?",
                  file=sys.stderr)
            return 4
        relay = subprocess.Popen(argvs.relay_argv(settings, spec),
                                 cwd=str(settings.repo(config.RELAY)),
                                 env=seeds.spawn_env())
        procs = [
            subprocess.Popen(commands[role], cwd=str(settings.repo(role)),
                             env=seeds.spawn_env())
            for role in roles
        ]
        rcs = [proc.wait() for proc in procs]
    except KeyboardInterrupt:
        print("interrupted: terminating agents", file=sys.stderr)
        with contextlib.suppress(Exception):
            for proc in procs:
                proc.terminate()
        rcs = [130]
    finally:
        if relay is not None:
            with contextlib.suppress(Exception):
                relay.terminate()
        with contextlib.suppress(OSError):
            hold.unlink()
        with contextlib.suppress(Exception):  # runtime ledger advances reach the volume
            persist.sync_ledger(settings)
    print("== series finished; when settled, send ONE report (still your call) ==")
    print(f"  (cwd {settings.cop_repo})\n"
          f"  $ uv run cosmos-cop report {shared_out}/result_<gid>.json"
          " --counted --send")
    return max(rcs)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
