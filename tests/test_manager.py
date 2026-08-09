"""Manager: standing <-> run swaps, argv shape, one-active-run, hold file, healing."""

from __future__ import annotations

import pytest

from cosmos_hub.manager import Manager
from cosmos_hub.runspec import RunRefusedError, RunSpec, web_runspec


@pytest.fixture
def notes():
    return []


@pytest.fixture
def manager(settings, fake_procs, notes):
    return Manager(settings, notify=lambda event, payload: notes.append((event, payload)))


def test_standing_uses_the_transport_only_asgi_app(manager, settings):
    manager.start_standing()
    assert set(manager.procs) == {"cop", "thief", "relay"}
    cop = manager.procs["cop"]
    assert "cosmos77_cop.net.asgi:app" in cop.argv and "8801" in cop.argv
    assert cop.cwd == str(settings.cop_repo)
    thief = manager.procs["thief"]
    assert "cosmos77_thief.net.asgi:app" in thief.argv and "8802" in thief.argv
    assert manager.agents_alive() == {"cop": True, "thief": True, "relay": True}


def test_run_swaps_standing_for_configured_serve(manager, settings, notes):
    manager.start_standing()
    standing_pids = {p.pid for p in manager.procs.values()}
    spec = web_runspec({"kind": "f2", "opponent_gid": "rival",
                        "their_cop_url": "https://r.example/cop/mcp",
                        "their_thief_url": "https://r.example/thief/mcp"})
    run_id = manager.start_run(spec)
    assert run_id == spec.out_stamp
    assert {p.pid for p in manager.procs.values()}.isdisjoint(standing_pids)
    cop = manager.procs["cop"].argv
    assert cop[:4] == ["uv", "run", "cosmos-cop", "serve"]
    assert cop[cop.index("--peer-url") + 1] == "https://r.example/thief/mcp"  # role swap
    assert cop[cop.index("--gid-b") + 1] == "rival"
    # ONE shared absolute out dir on the volume, identical for both agents
    shared = str(settings.shared_runs_dir(run_id))
    assert cop[cop.index("--out") + 1] == shared
    assert "--events" in cop
    thief = manager.procs["thief"].argv
    assert thief[thief.index("--peer-url") + 1] == "https://r.example/cop/mcp"
    assert thief[thief.index("--out") + 1] == shared
    assert settings.shared_runs_dir(run_id).is_dir()
    # parity split: "cosmos77" < "rival" so our cop owns the odd windows
    assert cop[cop.index("--windows-spec") + 1] == "1,3,5"
    assert thief[thief.index("--windows-spec") + 1] == "2,4,6"
    # exactly one closer: thief owns window 6, so ONLY the cop carries --no-close
    assert "--no-close" in cop and "--no-close" not in thief
    assert ("run_started", {"run_id": run_id, "kind": "f2", "opponent": "rival",
                            "windows": 6}) in notes


def test_selfplay_wires_loopback_peers_and_alternate_labels(manager, settings):
    spec = web_runspec({"kind": "selfplay", "windows": 2})
    manager.start_run(spec)
    cop = manager.procs["cop"].argv
    thief = manager.procs["thief"].argv
    assert cop[cop.index("--peer-url") + 1] == "http://127.0.0.1:8802/mcp"
    assert thief[thief.index("--peer-url") + 1] == "http://127.0.0.1:8801/mcp"
    assert "--alternate-labels" in cop and "--alternate-labels" in thief
    assert cop[cop.index("--gid-b") + 1] == "cosmos77-mirror"
    # selfplay is the ONLY kind with per-role dirs and no parity split / closer flags
    assert cop[cop.index("--out") + 1] == str(settings.runs_dir("cop", spec.out_stamp))
    assert thief[thief.index("--out") + 1] == str(settings.runs_dir("thief", spec.out_stamp))
    assert "--windows-spec" not in cop and "--windows-spec" not in thief
    assert "--no-close" not in cop and "--no-close" not in thief


def test_single_url_f1_spawns_only_the_window1_owner(manager):
    # "cosmos77" sorts before "smngrp05": our cop plays (and closes) the single window
    spec = web_runspec({"kind": "f1", "opponent_gid": "smngrp05",
                        "their_single_url": "https://one.example/mcp"})
    manager.start_run(spec)
    argv = manager.procs["cop"].argv
    assert argv[argv.index("--peer-url") + 1] == "https://one.example/mcp"
    assert argv[argv.index("--windows") + 1] == "1"
    assert argv[argv.index("--windows-spec") + 1] == "1"
    assert "--no-close" not in argv
    assert "thief" not in manager.procs  # no window of ours to play


def test_f1_against_gid_sorting_first_gives_our_thief_window1(manager):
    # ASCII: "SMNGRP05" (uppercase) sorts before "cosmos77" → THEIR cop plays odds,
    # so OUR thief owns window 1 and our cop plays nothing.
    spec = web_runspec({"kind": "f1", "opponent_gid": "SMNGRP05",
                        "their_single_url": "https://one.example/mcp"})
    manager.start_run(spec)
    thief = manager.procs["thief"].argv
    assert thief[thief.index("--windows-spec") + 1] == "1"
    assert "--no-close" not in thief
    assert "cop" not in manager.procs


def test_one_active_run_at_a_time(manager):
    manager.start_run(web_runspec({"kind": "selfplay"}))
    with pytest.raises(RunRefusedError):
        manager.start_run(web_runspec({"kind": "selfplay"}))


def test_tick_reaps_finished_run_and_returns_to_standing(manager, notes):
    manager.start_run(web_runspec({"kind": "selfplay"}))
    for proc in manager.procs.values():
        proc.rc = 0  # both agents exited: series over
    manager.tick()
    assert manager.active is None
    assert [event for event, _ in notes if event == "run_ended"] == ["run_ended"]
    assert "standing" in manager.procs["cop"].argv[3] or \
        "asgi" in " ".join(manager.procs["cop"].argv)


def test_tick_heals_dead_standing_agents(manager):
    manager.start_standing()
    manager.procs["cop"].rc = 1  # crashed
    old_thief = manager.procs["thief"].pid
    manager.tick()
    assert manager.agents_alive() == {"cop": True, "thief": True, "relay": True}
    assert manager.procs["thief"].pid != old_thief  # full respawn, fresh trio


def test_hold_file_stands_everything_down(manager, settings):
    manager.start_standing()
    settings.hold_file.parent.mkdir(parents=True, exist_ok=True)
    settings.hold_file.write_text("counted hold")
    manager.tick()
    assert manager.procs == {}
    with pytest.raises(RunRefusedError):
        manager.start_run(web_runspec({"kind": "selfplay"}))
    settings.hold_file.unlink()
    manager.tick()
    assert manager.agents_alive() == {"cop": True, "thief": True, "relay": True}


def test_stop_run_returns_to_standing(manager):
    assert manager.stop_run() is False  # nothing active
    manager.start_run(web_runspec({"kind": "selfplay"}))
    assert manager.stop_run() is True
    assert manager.active is None
    assert set(manager.procs) == {"cop", "thief", "relay"}  # standing again


def test_missing_opponent_url_refused(manager):
    spec = RunSpec(kind="f1", opponent_gid="rival", windows=1, out_stamp="f1-x")
    with pytest.raises(RunRefusedError):
        manager.start_run(spec)


def test_scent_model_passes_through_to_both_serves(manager):
    spec = web_runspec({"kind": "f2", "opponent_gid": "rival",
                        "their_single_url": "https://one.example/mcp",
                        "scent_model": "multiplicative_book_v1"})
    manager.start_run(spec)
    for role in ("cop", "thief"):
        argv = manager.procs[role].argv
        assert argv[argv.index("--scent-model") + 1] == "multiplicative_book_v1"


def test_hold_file_mid_web_run_clears_active_and_notifies_stop(manager, settings, notes):
    run_id = manager.start_run(web_runspec({"kind": "selfplay"}))
    settings.hold_file.parent.mkdir(parents=True, exist_ok=True)
    settings.hold_file.write_text("counted hold")
    manager.tick()  # hold appears while the run is live: kill AND close the run
    assert manager.procs == {} and manager.active is None
    assert ("run_stopped", {"run_id": run_id}) in notes
    settings.hold_file.unlink()
    manager.tick()  # back to standing; the dead run must NOT be reported as ended
    assert [e for e, _ in notes if e == "run_ended"] == []
    assert manager.agents_alive() == {"cop": True, "thief": True, "relay": True}


def test_unknown_scent_model_refused_and_absent_by_default(manager):
    with pytest.raises(RunRefusedError):
        web_runspec({"kind": "selfplay", "scent_model": "additive_v9"})
    manager.start_run(web_runspec({"kind": "selfplay"}))
    assert "--scent-model" not in manager.procs["cop"].argv
