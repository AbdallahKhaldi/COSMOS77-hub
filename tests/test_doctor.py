"""/api/doctor: mocked subprocess, SSRF rails, shared ChallengeGate budget, envelopes."""

from __future__ import annotations

import subprocess

import pytest

import cosmos_hub.doctor as doctor_mod
from cosmos_hub.challenge import ChallengeGate
from tests.test_challenge import PUBLIC_IP, StubManager, resolver_returning

GOOD_JSON = '{"verdict": "COMPATIBLE", "checks": [{"name": "tls", "ok": true}]}'


class Completed:
    def __init__(self, rc=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = rc, stdout, stderr


def install_doctor(monkeypatch, result=None, exc=None):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        if exc is not None:
            raise exc
        return result

    monkeypatch.setattr(doctor_mod.subprocess, "run", fake_run)
    return calls


@pytest.fixture
def doctor_client(client):
    client.app.state.challenge_resolver = resolver_returning(PUBLIC_IP)
    return client


def test_success_returns_doctor_json_verbatim_plus_elapsed(doctor_client, monkeypatch, settings):
    calls = install_doctor(monkeypatch, Completed(stdout=GOOD_JSON))
    response = doctor_client.post("/api/doctor", json={"url": "https://rival.example/mcp"})
    assert response.status_code == 200
    body = response.json()
    assert body["verdict"] == "COMPATIBLE"
    assert body["checks"] == [{"name": "tls", "ok": True}]
    assert isinstance(body["elapsed_ms"], int) and body["elapsed_ms"] >= 0
    argv, kwargs = calls[0]
    assert isinstance(argv, list)  # argv list only — user input never becomes a shell string
    assert argv[0].endswith("/.venv/bin/cosmos-cop")
    assert argv[1:4] == ["doctor", "--json", "--url"]
    assert argv[4] == "https://rival.example/mcp"
    assert kwargs["cwd"] == str(settings.cop_repo)
    assert kwargs["timeout"] == 60.0
    assert "shell" not in kwargs


def test_pair_urls_and_gid_map_to_flags(doctor_client, monkeypatch):
    calls = install_doctor(monkeypatch, Completed(stdout=GOOD_JSON))
    response = doctor_client.post("/api/doctor", json={
        "cop_url": "https://r.example/cop/mcp", "thief_url": "https://r.example/thief/mcp",
        "gid": "rival05"})
    assert response.status_code == 200
    argv, _ = calls[0]
    assert argv[argv.index("--cop-url") + 1] == "https://r.example/cop/mcp"
    assert argv[argv.index("--thief-url") + 1] == "https://r.example/thief/mcp"
    assert argv[argv.index("--gid") + 1] == "rival05"
    assert "--url" not in argv


def test_json_on_last_line_after_human_noise_still_parses(doctor_client, monkeypatch):
    install_doctor(monkeypatch, Completed(stdout='probing peer...\n{"ok": true}\n'))
    response = doctor_client.post("/api/doctor", json={"url": "https://r.example/mcp"})
    assert response.status_code == 200 and response.json()["ok"] is True


def test_garbage_output_yields_502_error_envelope(doctor_client, monkeypatch):
    install_doctor(monkeypatch, Completed(rc=1, stdout="Traceback (most recent call last):"))
    response = doctor_client.post("/api/doctor", json={"url": "https://r.example/mcp"})
    assert response.status_code == 502
    body = response.json()
    assert body["error"] == "doctor produced no valid JSON"
    assert body["rc"] == 1 and "Traceback" in body["tail"] and "elapsed_ms" in body


def test_non_object_json_is_garbage_too(doctor_client, monkeypatch):
    install_doctor(monkeypatch, Completed(stdout="[1, 2]"))
    assert doctor_client.post("/api/doctor",
                              json={"url": "https://r.example/mcp"}).status_code == 502


def test_missing_subcommand_is_503(doctor_client, monkeypatch):
    for output in ("cosmos-cop: unknown subcommand 'doctor'",
                   "usage: cosmos-cop doctor [-h] ..."):
        install_doctor(monkeypatch, Completed(rc=2, stderr=output))
        response = doctor_client.post("/api/doctor", json={"url": "https://r.example/mcp"})
        assert response.status_code == 503
        assert response.json()["detail"] == "doctor unavailable"
        doctor_client.app.state.challenge_gate = ChallengeGate()  # reset cooldown between posts


def test_timeout_is_504_and_missing_uv_is_503(doctor_client, monkeypatch):
    install_doctor(monkeypatch, exc=subprocess.TimeoutExpired(cmd="doctor", timeout=60))
    assert doctor_client.post("/api/doctor",
                              json={"url": "https://r.example/mcp"}).status_code == 504
    doctor_client.app.state.challenge_gate = ChallengeGate()
    install_doctor(monkeypatch, exc=FileNotFoundError("uv"))
    assert doctor_client.post("/api/doctor",
                              json={"url": "https://r.example/mcp"}).status_code == 503


def test_ssrf_rails_reject_before_any_subprocess(doctor_client, monkeypatch):
    calls = install_doctor(monkeypatch, Completed(stdout=GOOD_JSON))
    bad = [
        ({"url": "http://r.example/mcp"}, 422),                      # https only
        ({"url": "https://r.example/" + "a" * 300}, 422),            # length cap
        ({}, 422),                                                   # no urls at all
        ({"cop_url": "https://r.example/mcp"}, 422),                 # pair incomplete
        ({"url": "https://r.example/mcp", "gid": "no spaces"}, 422),  # gid charset
        ({"url": "https://r.example/mcp", "gid": "--gid"}, 422),     # no flag smuggling
        ({"url": "https://r.example/mcp", "gid": "x --counted"}, 403),
        ([1, 2], 422),                                               # body not an object
    ]
    for body, code in bad:
        assert doctor_client.post("/api/doctor", json=body).status_code == code, body
    doctor_client.app.state.challenge_resolver = resolver_returning("10.0.0.7")
    assert doctor_client.post("/api/doctor",
                              json={"url": "https://sneaky.example/mcp"}).status_code == 422
    assert calls == []  # nothing ever shelled


def test_doctor_and_challenge_share_one_gate_budget(doctor_client, monkeypatch):
    install_doctor(monkeypatch, Completed(stdout=GOOD_JSON))
    clock = {"now": 1_754_700_000.0}
    doctor_client.app.state.challenge_gate = ChallengeGate(clock=lambda: clock["now"])
    doctor_client.app.state.manager = StubManager()

    assert doctor_client.post("/api/doctor",
                              json={"url": "https://r.example/mcp"}).status_code == 200
    clock["now"] += 45  # doctor started the shared 90 s cooldown
    challenge_body = {"kind": "f1", "their_single_url": "https://r.example/mcp"}
    assert doctor_client.post("/api/challenge", json=challenge_body).status_code == 429
    assert doctor_client.post("/api/doctor",
                              json={"url": "https://r.example/mcp"}).status_code == 429
    clock["now"] += 50  # cooldown over; challenge consumes the same daily budget
    assert doctor_client.post("/api/challenge", json=challenge_body).status_code == 200
    for _ in range(8):  # 2 used; exhaust the shared 10/day
        clock["now"] += 120
        assert doctor_client.post("/api/doctor",
                                  json={"url": "https://r.example/mcp"}).status_code == 200
    clock["now"] += 120
    response = doctor_client.post("/api/doctor", json={"url": "https://r.example/mcp"})
    assert response.status_code == 429 and "daily" in response.json()["detail"]
