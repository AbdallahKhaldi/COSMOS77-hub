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
    """A press admits through the gate and starts kind=selfplay windows=1."""
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
    assert response.json() == {"run_id": "selfplay-test-0001", "watch": "live"}
    spec, source = calls[0]
    assert (spec.kind, spec.windows, source) == ("selfplay", 1, "demo")
    assert spec.their_cop_url is None and spec.their_thief_url is None


def test_demo_shares_the_challenge_rate_budget(app_client: Any) -> None:
    """The same gate that guards challenges guards the demo lane."""
    gate = app_client.app.state.challenge_gate

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
