"""``cosmos-hub-counted`` — the ONLY way a counted run starts on the hub (SSH terminal).

No web request can reach this: it is a console script that refuses non-TTY stdin,
prints the exact armed commands, and executes them only after the operator types
``ARM COUNTED``.  While it runs, a hold-file keeps the hub manager off the agent
ports; reporting stays a separate deliberate step and is printed, never auto-sent.
"""

from __future__ import annotations

import argparse
import contextlib
import shlex
import socket
import subprocess
import sys
import time

from . import argvs, config
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
    commands = {role: argvs.counted_argv(role, spec, settings) for role in config.ROLES}
    print("== COUNTED RUN — the following ARMED commands will be executed ==")
    for role, command in commands.items():
        print(f"  (cwd {settings.repo(role)})\n  $ {shlex.join(command)}")
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
    procs: list[subprocess.Popen[bytes]] = []
    try:
        ports = list(argvs.PORTS.values())
        print(f"waiting for the hub to release ports {ports} (hold file set) ...")
        if not _wait_ports_free(ports, _PORT_WAIT_S):
            print("REFUSED: agent ports still busy — is the hub honoring the hold file?",
                  file=sys.stderr)
            return 4
        procs = [
            subprocess.Popen(commands[role], cwd=str(settings.repo(role)),
                             env=argvs.spawn_env())
            for role in config.ROLES
        ]
        rcs = [proc.wait() for proc in procs]
    except KeyboardInterrupt:
        print("interrupted: terminating agents", file=sys.stderr)
        with contextlib.suppress(Exception):
            for proc in procs:
                proc.terminate()
        rcs = [130]
    finally:
        with contextlib.suppress(OSError):
            hold.unlink()
    print("== series finished; when settled, send BOTH reports (still your call) ==")
    for role in config.ROLES:
        console = "cosmos-cop" if role == "cop" else "cosmos-thief"
        print(f"  (cwd {settings.repo(role)})\n"
              f"  $ uv run {console} report runs/{spec.out_stamp}/result_<gid>.json"
              " --counted --send")
    return max(rcs)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
