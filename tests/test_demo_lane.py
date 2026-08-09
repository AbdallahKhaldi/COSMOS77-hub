"""The public START lane: real selfplay per press, rate-limited, never counted."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException


@pytest.fixture()
def app_client(client: Any) -> Any:
    """Reuse the project's TestClient fixture under a clearer name."""
    return client


def test_demo_starts_a_one_window_selfplay(app_client: Any) -> None:
    """A press admits through the DEMO gate and starts kind=selfplay windows=1."""
    calls: list[Any] = []
    manager = app_client.app.state.manager
    original = manager.start_run

    def spy(spec: Any, source: str = "") -> str:
        calls.append((spec, source))
        return "selfplay-test-0001"

    manager.start_run = spy
    try:
        response = app_client.post("/api/demo")
    finally:
        manager.start_run = original
    assert response.status_code == 200
    assert response.json() == {"run_id": "selfplay-test-0001", "watch": "live",
                               "joined": False}
    spec, source = calls[0]
    assert (spec.kind, spec.windows, source) == ("selfplay", 1, "demo")
    assert spec.their_cop_url is None and spec.their_thief_url is None


def test_press_during_a_live_run_joins_it_instead_of_refusing(app_client: Any) -> None:
    """Watching an in-progress pursuit is free — no cooldown, no new run."""
    from cosmos_hub.runspec import RunSpec

    manager = app_client.app.state.manager
    manager.active = RunSpec(kind="selfplay", opponent_gid="cosmos77-mirror",
                             windows=1, out_stamp="selfplay-live-0042")
    try:
        response = app_client.post("/api/demo")
    finally:
        manager.active = None
    assert response.status_code == 200
    body = response.json()
    assert body["joined"] is True and body["run_id"] == "selfplay-live-0042"


def test_demo_gate_is_independent_of_the_challenge_gate(app_client: Any) -> None:
    """An exhausted challenge quota must never route visitors to the tape."""
    challenge_gate = app_client.app.state.challenge_gate
    challenge_gate.count = 10**6
    challenge_gate.day = "2099-01-01"  # force-exhausted
    manager = app_client.app.state.manager
    original = manager.start_run
    manager.start_run = lambda spec, source="": "selfplay-free-0007"
    try:
        response = app_client.post("/api/demo")
    finally:
        manager.start_run = original
        challenge_gate.count = 0
    assert response.status_code == 200


def test_demo_shares_the_demo_rate_budget(app_client: Any) -> None:
    """The demo lane has its own (generous) gate; a refusal still maps to 429."""
    gate = app_client.app.state.demo_gate

    def refuse() -> None:
        raise HTTPException(429, "cooldown: try again in 30s")

    original = gate.admit
    gate.admit = refuse
    try:
        response = app_client.post("/api/demo")
    finally:
        gate.admit = original
    assert response.status_code == 429


def test_demo_busy_maps_to_409(app_client: Any) -> None:
    """A second press while a run is active reports busy, not an error page."""
    from cosmos_hub.runspec import RunRefusedError

    manager = app_client.app.state.manager
    original = manager.start_run

    def busy(spec: Any, source: str = "") -> str:
        raise RunRefusedError("a run is already active")

    manager.start_run = busy
    try:
        response = app_client.post("/api/demo")
    finally:
        manager.start_run = original
    assert response.status_code == 409


def test_demo_lane_carries_no_counted_surface(app_client: Any) -> None:
    """The route takes no body at all — nothing user-controlled reaches argv."""
    manager = app_client.app.state.manager
    original = manager.start_run
    seen: list[Any] = []
    manager.start_run = lambda spec, source="": (seen.append(spec), "run-x")[1]
    try:
        response = app_client.post(
            "/api/demo", json={"kind": "counted", "argv": "--counted"}
        )
    finally:
        manager.start_run = original
    assert response.status_code == 200
    assert seen[0].kind == "selfplay"
