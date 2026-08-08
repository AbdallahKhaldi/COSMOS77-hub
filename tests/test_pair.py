"""Pairing endpoint: primary CLI, python -c fallback, both as subprocesses."""

from __future__ import annotations

import json
import subprocess

from cosmos_hub import pair

PACKET = {"opponent": "rival", "game_id": "cosmos77-vs-rival", "message": "yo"}


def _completed(rc, stdout=""):
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr="")


def test_primary_cli_used_when_available(client, settings, monkeypatch):
    calls = []

    def fake_run(argv, cwd):
        calls.append((argv, cwd))
        return _completed(0, json.dumps(PACKET) + "\n")

    monkeypatch.setattr(pair, "_run", fake_run)
    response = client.post("/api/pair", json={"opponent": "rival",
                                              "their_cop_url": "https://r.example/cop"})
    assert response.status_code == 200
    assert response.json() == PACKET
    argv, cwd = calls[0]
    assert argv[:5] == ["uv", "run", "cosmos-cop", "pair", "--json"]
    assert "https://hub.test/cop/mcp" in argv and "https://hub.test/thief/mcp" in argv
    assert cwd == str(settings.cop_repo)


def test_fallback_python_dash_c_when_cli_missing(client, settings, monkeypatch):
    calls = []

    def fake_run(argv, cwd):
        calls.append(argv)
        if "pair" in argv:  # Track A's subcommand not landed yet
            return _completed(2, "")
        return _completed(0, json.dumps(PACKET))

    monkeypatch.setattr(pair, "_run", fake_run)
    response = client.post("/api/pair", json={"opponent": "rival"})
    assert response.status_code == 200 and response.json() == PACKET
    assert calls[1][:4] == ["uv", "run", "python", "-c"]
    assert "cosmos77_cop.console.pairing" in calls[1][4]


def test_pair_validates_opponent(client):
    assert client.post("/api/pair", json={"opponent": "bad gid!"}).status_code == 422
    assert client.post("/api/pair", json={}).status_code == 422


def test_pair_502_when_both_paths_fail(client, monkeypatch):
    monkeypatch.setattr(pair, "_run", lambda argv, cwd: _completed(1, ""))
    response = client.post("/api/pair", json={"opponent": "rival"})
    assert response.status_code == 502
