"""RAIL: no web-reachable path can ever arm a counted run (403, pinned here)."""

from __future__ import annotations

import pytest

from cosmos_hub import argvs
from cosmos_hub.manager import Manager
from cosmos_hub.runspec import CountedRefusedError, RunSpec, web_runspec


def _login(client):
    response = client.post("/api/admin/login", json={"password": "hub-pw"})
    assert response.status_code == 200


def test_challenge_rejects_counted_kind(client):
    response = client.post("/api/challenge", json={
        "kind": "counted", "their_cop_url": "https://x.example/mcp",
        "their_thief_url": "https://x.example/mcp",
    })
    assert response.status_code == 403


def test_challenge_rejects_counted_argv_smuggling(client):
    response = client.post("/api/challenge", json={
        "kind": "f1", "their_single_url": "https://x.example/mcp --counted",
    })
    assert response.status_code == 403


def test_admin_run_rejects_counted_kind(client):
    _login(client)
    response = client.post("/api/admin/run", json={"kind": "counted"})
    assert response.status_code == 403


def test_admin_run_rejects_counted_argv_anywhere(client):
    _login(client)
    response = client.post("/api/admin/run", json={
        "kind": "f2", "their_cop_url": "https://x.example/mcp",
        "their_thief_url": "https://x.example/--counted/mcp",
    })
    assert response.status_code == 403


def test_web_runspec_refuses_counted_before_anything_else():
    with pytest.raises(CountedRefusedError):
        web_runspec({"kind": "counted"})
    with pytest.raises(CountedRefusedError):
        web_runspec({"kind": "f1", "opponent_gid": "x", "note": "--counted"})


def test_manager_refuses_counted_even_if_a_route_forgot(settings, fake_procs):
    manager = Manager(settings)
    spec = RunSpec(kind="counted", opponent_gid="rival", windows=6, out_stamp="c-1")
    with pytest.raises(CountedRefusedError):
        manager.start_run(spec, source="unit")
    assert manager.procs == {}


def test_web_run_argvs_never_contain_counted(settings):
    for kind in ("selfplay", "f1", "f2"):
        spec = web_runspec({"kind": kind, "opponent_gid": "rival",
                            "their_cop_url": "https://a.example/mcp",
                            "their_thief_url": "https://a.example/mcp"})
        for role in argvs.active_roles(spec, settings):
            assert "--counted" not in argvs.run_argv(role, spec, settings)


def test_report_dry_run_argv_is_structurally_friendly(settings):
    argv = argvs.report_dry_run_argv("runs/x/result_y.json", settings)
    assert "--send" not in argv
    assert "--counted" not in argv
