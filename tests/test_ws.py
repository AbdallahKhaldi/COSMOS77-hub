"""WS: snapshot-on-connect then a monotonic per-perspective stream (fake tailer)."""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect


def test_snapshot_then_stream_seq_monotonic(client):
    hub = client.app.state.hub
    with client.websocket_connect("/ws/live?perspective=police") as ws:
        first = ws.receive_json()
        assert first["type"] == "snapshot"
        assert first["perspective"] == "police"
        base_seq = first["seq"]

        # fake tailer: emit envelopes directly into the hub's envelope log
        hub.log.emit("view", "police", {"step": 1, "banner": "YOUR TURN"})
        hub.log.emit("view", "thief", {"step": 1, "banner": "LOCKED"})  # other feed
        hub.log.emit("status", "police", {"state": "running"})

        second = ws.receive_json()
        third = ws.receive_json()
    assert [second["type"], third["type"]] == ["view", "status"]
    assert second["payload"]["step"] == 1
    assert base_seq < second["seq"] < third["seq"]
    assert {second["perspective"], third["perspective"]} == {"police"}


def test_thief_socket_never_sees_police_frames(client):
    hub = client.app.state.hub
    with client.websocket_connect("/ws/live?perspective=thief") as ws:
        assert ws.receive_json()["type"] == "snapshot"
        hub.log.emit("view", "police", {"step": 5})
        hub.log.emit("view", "thief", {"step": 6})
        message = ws.receive_json()
    assert message["perspective"] == "thief"
    assert message["payload"]["step"] == 6


def test_inbound_frames_cannot_switch_perspective(client):
    hub = client.app.state.hub
    with client.websocket_connect("/ws/live?perspective=police") as ws:
        ws.receive_json()
        ws.send_text('{"perspective": "thief"}')  # ignored by design
        hub.log.emit("view", "thief", {"step": 9})
        hub.log.emit("view", "police", {"step": 10})
        message = ws.receive_json()
    assert message["perspective"] == "police"
    assert message["payload"]["step"] == 10


def test_missing_or_invalid_perspective_is_refused(client):
    for query in ("", "?perspective=both", "?perspective=police,thief"):
        with pytest.raises(WebSocketDisconnect), \
                client.websocket_connect(f"/ws/live{query}") as ws:
            ws.receive_json()


def test_snapshot_reflects_prior_events(client):
    hub = client.app.state.hub
    hub.log.emit("view", "police", {"step": 3, "banner": "LOCKED"})
    hub.log.emit("window_end", "police", {"sub_game": 1, "result": "capture"})
    with client.websocket_connect("/ws/live?perspective=police") as ws:
        snapshot = ws.receive_json()
    assert snapshot["payload"]["view"]["step"] == 3
    assert snapshot["payload"]["windows"][0]["sub_game"] == 1
    assert snapshot["seq"] >= 2


def test_snapshot_after_run_end_carries_no_dead_run_view(client):
    hub = client.app.state.hub
    hub.notify("run_started", {"run_id": "f1-20260809-120000", "kind": "f1"})
    hub.log.emit("view", "police", {"step": 7, "self_pos": [3, 4]})
    hub.log.emit("window_end", "police", {"sub_game": 1, "result": "capture"})
    hub.notify("run_ended", {"run_id": "f1-20260809-120000", "kind": "f1"})
    for perspective in ("police", "thief"):
        envelope = hub.log.snapshot_envelope(perspective)
        assert envelope["run_id"] == "standing"
        payload = envelope["payload"]
        assert "view" not in payload and "windows" not in payload and "final" not in payload
        assert payload["status"]["state"] == "standing"
    # a NEW connection replays the retained finished run (watchable even when the
    # game settled in seconds); the dead view still never rides the snapshot itself
    with client.websocket_connect("/ws/live?perspective=police") as ws:
        replayed = [ws.receive_json() for _ in range(4)]
    kinds = [e["type"] for e in replayed]
    view = next(e for e in replayed if e["type"] == "view")
    assert view["payload"]["step"] == 7 and "window_end" in kinds
    # once a NEW run starts, history clears: a fresh viewer gets the clean snapshot
    hub.notify("run_started", {"run_id": "f1-next", "kind": "f1"})
    with client.websocket_connect("/ws/live?perspective=police") as ws:
        clean = ws.receive_json()
    assert clean["type"] == "snapshot" and "view" not in clean["payload"]


def test_a_settled_run_stops_being_replayed_to_brand_new_viewers() -> None:
    """History exists for the START presser's socket, not for every later visitor.

    Retained forever it turned each page load into a performance of the last finished
    game, labelled LIVE — the arena playing a recording of itself.
    """
    from cosmos_hub import broadcast

    caster = broadcast.Broadcaster()
    caster._publish({"perspective": "police", "type": "view", "payload": {"step": 1}})
    assert caster.history_for("police"), "a live run must reach a late-connecting viewer"

    caster.mark_settled()
    assert caster.history_for("police"), "within the grace window it is still news"

    caster._settled_at -= broadcast.SETTLED_GRACE_S + 1  # age it past the window
    assert caster.history_for("police") == [], "a stale run must never replay as live"

    caster.clear_history()
    caster._publish({"perspective": "police", "type": "view", "payload": {"step": 1}})
    assert caster.history_for("police"), "a NEW run replays again from scratch"
