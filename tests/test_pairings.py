"""Per-opponent constitutions: admin-installed, agent-validated, auto-used by Engage."""

from __future__ import annotations

import json

from cosmos_hub import pairings
from tests.conftest import LEAGUE_CONFIG


def _login(client):
    assert client.post("/api/admin/login", json={"password": "hub-pw"}).status_code == 200


def test_install_requires_admin(client):
    assert client.post("/api/admin/pairing-config",
                       json={"gid": "x", "config": {}}).status_code == 401


def test_install_validates_with_the_agents_own_loader(client, settings, monkeypatch):
    """The exact loader that would refuse at spawn refuses at upload — same words."""
    _login(client)
    calls = {}

    def fake_validate(s, path):
        calls["path"] = str(path)
        return {"grid": 7, "moves": 35, "barriers": 14, "map": "Haifa"}

    monkeypatch.setattr(pairings, "_validate_with_agent_loader", fake_validate)
    cfg = dict(LEAGUE_CONFIG)
    response = client.post("/api/admin/pairing-config",
                           json={"gid": "sharNamr", "config": cfg})
    assert response.status_code == 200
    body = response.json()
    assert body["installed"] == "sharNamr" and len(body["canonical_sha256"]) == 64
    assert pairings.pairing_config_path(settings, "sharNamr").is_file()
    assert calls["path"].endswith("pairings/sharNamr.json")


def test_a_refused_config_is_removed_never_half_installed(client, settings, monkeypatch):
    from fastapi import HTTPException

    _login(client)

    def refuse(s, path):
        raise HTTPException(422, "the agents refuse this config: bad grid")

    monkeypatch.setattr(pairings, "_validate_with_agent_loader", refuse)
    response = client.post("/api/admin/pairing-config",
                           json={"gid": "badteam", "config": {"nope": 1}})
    assert response.status_code == 422
    assert not pairings.pairing_config_path(settings, "badteam").is_file(), \
        "a refused file must never remain where Engage could find it"


def test_bad_gid_and_non_object_config_refused(client):
    _login(client)
    assert client.post("/api/admin/pairing-config",
                       json={"gid": "../evil", "config": {}}).status_code == 422
    assert client.post("/api/admin/pairing-config",
                       json={"gid": "ok", "config": "a string"}).status_code == 422


def test_active_pairing_config_resolution(settings):
    assert pairings.active_pairing_config(settings, "nobody") is None
    path = pairings.pairing_config_path(settings, "someteam")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(LEAGUE_CONFIG), encoding="utf-8")
    assert pairings.active_pairing_config(settings, "someteam") == str(path)


def test_engage_plays_the_installed_file_for_that_gid(client, settings, fake_procs, monkeypatch):
    """The whole point: once installed, the challenge run carries --config THEIR file."""
    from cosmos_hub import pairings as pairings_mod

    path = pairings_mod.pairing_config_path(settings, "sharNamr")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(LEAGUE_CONFIG), encoding="utf-8")
    client.app.state.challenge_resolver = lambda host: ["93.184.216.34"]  # public, no DNS
    response = client.post("/api/challenge", json={
        "kind": "f1", "opponent_gid": "sharNamr",
        "their_single_url": "https://opponent.example/mcp",
    })
    assert response.status_code == 200
    argvs_seen = [" ".join(p.argv) for p in fake_procs.REGISTRY.values()]
    assert any(f"--config {path}" in a for a in argvs_seen), argvs_seen
