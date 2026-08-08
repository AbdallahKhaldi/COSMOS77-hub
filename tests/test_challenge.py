"""Public challenge: URL hygiene, SSRF guard, and the mocked-clock rate limits."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from cosmos_hub.challenge import ChallengeGate, check_url

PUBLIC_IP = "93.184.216.34"


def resolver_returning(*addresses):
    return lambda host: list(addresses)


class StubManager:
    def __init__(self):
        self.active = None
        self.started = []

    def start_run(self, spec, source="web"):
        self.started.append((spec, source))
        return spec.out_stamp

    def stop_run(self):
        return False

    def shutdown(self):
        return None


@pytest.fixture
def challenge_client(client):
    client.app.state.challenge_resolver = resolver_returning(PUBLIC_IP)
    client.app.state.manager = StubManager()
    return client


def _payload(**overrides):
    body = {"kind": "f1", "opponent_gid": "rivals",
            "their_cop_url": "https://rival.example/cop/mcp",
            "their_thief_url": "https://rival.example/thief/mcp"}
    body.update(overrides)
    return body


def test_happy_path_returns_run_id_and_watch_url(challenge_client):
    response = challenge_client.post("/api/challenge", json=_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"].startswith("f1-")
    assert body["watch_url"] == f"/?run={body['run_id']}"
    spec, source = challenge_client.app.state.manager.started[0]
    assert source == "challenge" and spec.windows == 1


def test_f2_runs_six_windows(challenge_client):
    response = challenge_client.post("/api/challenge",
                                     json=_payload(kind="f2",
                                                   their_single_url="https://r.example/mcp",
                                                   their_cop_url="", their_thief_url=""))
    assert response.status_code == 200
    spec, _ = challenge_client.app.state.manager.started[0]
    assert spec.windows == 6 and spec.their_single_url == "https://r.example/mcp"


def test_http_scheme_rejected(challenge_client):
    response = challenge_client.post(
        "/api/challenge", json=_payload(their_cop_url="http://rival.example/mcp"))
    assert response.status_code == 422


def test_overlong_url_rejected(challenge_client):
    response = challenge_client.post(
        "/api/challenge", json=_payload(their_cop_url="https://r.example/" + "a" * 300))
    assert response.status_code == 422


def test_private_and_loopback_resolutions_rejected():
    for address in ("127.0.0.1", "10.1.2.3", "192.168.1.9", "169.254.0.5", "::1", "fd00::1"):
        with pytest.raises(HTTPException) as excinfo:
            check_url("https://sneaky.example/mcp", resolver_returning(address))
        assert excinfo.value.status_code == 422
    check_url("https://honest.example/mcp", resolver_returning(PUBLIC_IP))  # no raise


def test_unresolvable_host_rejected(challenge_client):
    def boom(host):
        raise OSError("NXDOMAIN")

    challenge_client.app.state.challenge_resolver = boom
    response = challenge_client.post("/api/challenge", json=_payload())
    assert response.status_code == 422


def test_missing_urls_rejected(challenge_client):
    response = challenge_client.post("/api/challenge", json={"kind": "f1"})
    assert response.status_code == 422


def test_one_concurrent_run(challenge_client):
    challenge_client.app.state.manager.active = object()
    response = challenge_client.post("/api/challenge", json=_payload())
    assert response.status_code == 409


def test_cooldown_and_daily_quota_with_mocked_clock(challenge_client):
    clock = {"now": 1_754_700_000.0}
    challenge_client.app.state.challenge_gate = ChallengeGate(clock=lambda: clock["now"])

    assert challenge_client.post("/api/challenge", json=_payload()).status_code == 200
    clock["now"] += 45  # inside the 90 s cooldown
    assert challenge_client.post("/api/challenge", json=_payload()).status_code == 429
    clock["now"] += 50  # 95 s after the start: cooldown over
    assert challenge_client.post("/api/challenge", json=_payload()).status_code == 200

    for _ in range(8):  # 2 used; run up to the 10/day limit
        clock["now"] += 120
        assert challenge_client.post("/api/challenge", json=_payload()).status_code == 200
    clock["now"] += 120
    response = challenge_client.post("/api/challenge", json=_payload())
    assert response.status_code == 429
    assert "daily" in response.json()["detail"]


def test_gate_resets_next_utc_day():
    clock = {"now": 1_754_700_000.0}
    gate = ChallengeGate(clock=lambda: clock["now"])
    for _ in range(10):
        gate.admit()
        gate.note_started()
        clock["now"] += 120
    with pytest.raises(HTTPException):
        gate.admit()
    clock["now"] += 86_400
    gate.admit()  # new UTC day: quota reset
