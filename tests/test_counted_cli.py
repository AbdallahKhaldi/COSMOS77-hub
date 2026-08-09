"""cosmos-hub-counted: TTY-only, exact confirmation phrase, hold-file discipline."""

from __future__ import annotations

import pytest

from cosmos_hub import counted_cli
from tests.conftest import DummyProc, make_settings

ARGS = ["--opponent-gid", "rival",
        "--their-cop-url", "https://r.example/cop/mcp",
        "--their-thief-url", "https://r.example/thief/mcp",
        "--stamp", "counted-test"]


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    monkeypatch.setattr(counted_cli.config, "load", lambda env=None: settings)
    monkeypatch.setattr(counted_cli, "_wait_ports_free", lambda ports, deadline: True)
    DummyProc.REGISTRY.clear()

    def popen(argv, cwd=None, env=None):
        proc = DummyProc(argv, cwd=cwd)
        proc.rc = 0
        return proc

    monkeypatch.setattr(counted_cli.subprocess, "Popen", popen)
    return settings


class FakeStdin:
    def __init__(self, tty):
        self._tty = tty

    def isatty(self):
        return self._tty


def _tty(monkeypatch, is_tty):
    monkeypatch.setattr(counted_cli.sys, "stdin", FakeStdin(is_tty))


def test_refuses_without_a_tty(cli_env, monkeypatch, capsys):
    _tty(monkeypatch, False)
    assert counted_cli.main(ARGS) == 2
    assert "interactive terminal" in capsys.readouterr().err


def test_refuses_wrong_confirmation(cli_env, monkeypatch, capsys):
    _tty(monkeypatch, True)
    monkeypatch.setattr("builtins.input", lambda prompt="": "arm counted")  # wrong case
    assert counted_cli.main(ARGS) == 3
    out = capsys.readouterr().out
    assert "--counted" in out  # the exact armed commands were printed first
    assert not cli_env.hold_file.exists()


def test_armed_run_executes_and_clears_hold(cli_env, monkeypatch, capsys):
    _tty(monkeypatch, True)
    seen_hold = {}

    def popen(argv, cwd=None, env=None):
        seen_hold["during"] = cli_env.hold_file.exists()
        proc = DummyProc(argv, cwd=cwd)
        proc.rc = 0
        return proc

    monkeypatch.setattr(counted_cli.subprocess, "Popen", popen)
    monkeypatch.setattr("builtins.input", lambda prompt="": "ARM COUNTED")
    assert counted_cli.main(ARGS) == 0
    out = capsys.readouterr().out
    assert seen_hold["during"] is True  # hub stood down while agents ran
    assert not cli_env.hold_file.exists()  # released afterwards
    shared = str(cli_env.shared_runs_dir("counted-test"))
    # ONE report command against the single shared result artifact
    assert out.count("--counted --send") == 1
    assert f"report {shared}/result_" in out
    cop_argv = next(p for p in DummyProc.REGISTRY.values() if "cosmos-cop" in p.argv[0]).argv
    assert "--counted" in cop_argv and "serve" in cop_argv
    assert cop_argv[cop_argv.index("--peer-url") + 1] == "https://r.example/thief/mcp"


def test_armed_topology_parity_split_shared_out_single_closer(cli_env, monkeypatch):
    _tty(monkeypatch, True)
    monkeypatch.setattr("builtins.input", lambda prompt="": "ARM COUNTED")
    assert counted_cli.main(ARGS) == 0
    spawned = list(DummyProc.REGISTRY.values())
    cop = next(p.argv for p in spawned if "cosmos-cop" in p.argv[0] and "serve" in p.argv)
    thief = next(p.argv for p in spawned if "cosmos-thief" in p.argv[0] and "serve" in p.argv)
    # complementary parity from the gid sort ("cosmos77" < "rival": cop odds)
    assert cop[cop.index("--windows-spec") + 1] == "1,3,5"
    assert thief[thief.index("--windows-spec") + 1] == "2,4,6"
    # ONE shared ABSOLUTE out dir under the data volume, identical for both agents
    shared = str(cli_env.shared_runs_dir("counted-test"))
    assert cop[cop.index("--out") + 1] == shared == thief[thief.index("--out") + 1]
    assert cli_env.shared_runs_dir("counted-test").is_dir()
    # exactly one closer: the window-6 owner (thief) closes, the cop gets --no-close
    assert "--no-close" in cop and "--no-close" not in thief
    # the window-parity relay is spawned so /mcp stays available under the hold
    relay = next(p.argv for p in spawned if "sparring_relay.py" in " ".join(p.argv))
    assert relay[relay.index("--odd-url") + 1].endswith(":8801/mcp")  # cop owns odds
    assert relay[relay.index("--even-url") + 1].endswith(":8802/mcp")


def test_bad_gid_refused(cli_env, monkeypatch):
    _tty(monkeypatch, True)
    assert counted_cli.main(["--opponent-gid", "bad gid!"]) == 2
