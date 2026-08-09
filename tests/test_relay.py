"""Sparring-relay subprocess: argv/cwd, healing, run reaping, hold, status surface."""

from __future__ import annotations

import pytest

from cosmos_hub.argvs import relay_argv
from cosmos_hub.manager import Manager
from cosmos_hub.runspec import web_runspec

EXPECTED_ARGV = [
    "uv", "run", "python", "scripts/sparring_relay.py",
    "--port", "8803",
    "--odd-url", "http://127.0.0.1:8801/mcp",
    "--even-url", "http://127.0.0.1:8802/mcp",
]


@pytest.fixture
def manager(settings, fake_procs):
    return Manager(settings)


def test_relay_argv_matches_the_script_flags():
    assert relay_argv() == EXPECTED_ARGV


def test_standing_spawns_relay_in_cop_repo(manager, settings):
    manager.start_standing()
    relay = manager.procs["relay"]
    assert relay.argv == EXPECTED_ARGV
    assert relay.cwd == str(settings.cop_repo)  # the script lives in the cop repo


def test_run_swap_respawns_relay_with_run_tag(manager, settings):
    manager.start_standing()
    standing_pid = manager.procs["relay"].pid
    run_id = manager.start_run(web_runspec({"kind": "selfplay"}))
    relay = manager.procs["relay"]
    assert relay.pid != standing_pid  # fresh window-parity state per run
    assert relay.argv == EXPECTED_ARGV
    assert (settings.logs_dir / f"relay-{run_id}.log").exists()


def test_live_relay_does_not_block_run_reaping(manager):
    manager.start_run(web_runspec({"kind": "selfplay"}))
    for role in ("cop", "thief"):
        manager.procs[role].rc = 0  # series over; relay is still running
    assert manager.procs["relay"].poll() is None
    manager.tick()
    assert manager.active is None  # reaped despite the live relay
    assert manager.agents_alive() == {"cop": True, "thief": True, "relay": True}


def test_relay_death_mid_run_heals_without_touching_agents(manager):
    manager.start_run(web_runspec({"kind": "selfplay"}))
    agent_pids = {r: manager.procs[r].pid for r in ("cop", "thief")}
    manager.procs["relay"].rc = 1  # relay crashed mid-run
    manager.tick()
    assert manager.active is not None  # run untouched
    assert {r: manager.procs[r].pid for r in ("cop", "thief")} == agent_pids
    assert manager.procs["relay"].poll() is None  # respawned


def test_relay_death_in_standing_triggers_full_heal(manager):
    manager.start_standing()
    manager.procs["relay"].rc = 1
    manager.tick()
    assert manager.agents_alive() == {"cop": True, "thief": True, "relay": True}


def test_hold_file_kills_relay_too(manager, settings):
    manager.start_standing()
    settings.hold_file.parent.mkdir(parents=True, exist_ok=True)
    settings.hold_file.write_text("counted hold")
    manager.tick()
    assert manager.procs == {}  # port 8803 freed with 8801/8802


def test_status_reports_relay_reachability(client):
    client.app.state.manager.start_standing()
    body = client.get("/api/status").json()
    assert body["agents"]["relay"] is True
    assert body["endpoints"]["single"].endswith("/mcp")
    client.app.state.manager.procs["relay"].rc = 1
    assert client.get("/api/status").json()["agents"]["relay"] is False
