"""Replay builder: frames from settled logs, seal re-verification, unsettled refusal."""

from __future__ import annotations

import json

import pytest

from cosmos_hub import replay
from cosmos_hub.frames import record_ok, window_frames
from tests.conftest import make_log, make_result, sealed, write_json


def _settled_run(settings, run_id="f2-20260809-101010", tamper=False):
    cop_dir = settings.runs_dir("cop", run_id)
    write_json(cop_dir / "log_cosmos77-vs-rival_g01.json", make_log(sub_game=1, tamper=tamper))
    write_json(cop_dir / "log_cosmos77-vs-rival_g02.json",
               make_log(sub_game=2, my_role="police"))
    write_json(cop_dir / "result_cosmos77-vs-rival.json", make_result())
    events = [
        {"t": "view", "role": "police", "sub_game": 1, "step": 1,
         "posterior": {"3,4": 0.9, "0,0": 0.1}, "perceived_scent": {"3,4": 0.9},
         "confidence": "fuzzy"},
        {"t": "view", "role": "thief", "sub_game": 1, "step": 1, "posterior": {}},
    ]
    (cop_dir / "events.jsonl").write_text(
        "".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
    return run_id


def test_record_seal_roundtrip():
    record = sealed({"step": 1, "role": "police"})
    assert record_ok(record)
    record["payload"]["role"] = "thief"
    assert not record_ok(record)


def test_window_frames_carry_both_positions_and_commit_ok():
    frames, per_step = window_frames(make_log(steps=3))
    assert len(frames) == 3 and per_step == [True, True, True]
    assert frames[0]["cop"] == [0, 1] and frames[0]["thief"] == [3, 4]
    assert frames[2]["step"] == 3 and frames[2]["window"] == 1
    assert frames[0]["hint"] == {"police": "hi", "thief": "hi"}


def test_build_verified_ok_with_belief_trace(settings):
    run_id = _settled_run(settings)
    document = replay.build(settings, run_id)
    assert document["verify"]["verdict"] == "Verified OK"
    assert all(document["verify"]["per_step"])
    assert len(document["frames"]) == 6  # 2 windows x 3 steps
    assert document["meta"]["windows"] == 2
    ghost = document["belief_trace"][0]
    assert ghost["ghost"] == [3, 4] and ghost["confidence"] == "fuzzy"
    assert document["frames"][0]["scent"] == {"3,4": 0.9}


def test_belief_trace_aligns_one_entry_per_frame_by_step(settings):
    """The agent writes ~2 events lines per step (YOUR TURN + LOCKED): dedupe by step."""
    run_id = "f2-20260809-141414"
    cop_dir = settings.runs_dir("cop", run_id)
    write_json(cop_dir / "log_cosmos77-vs-rival_g01.json", make_log(sub_game=1, steps=3))
    write_json(cop_dir / "result_cosmos77-vs-rival.json", make_result())
    events = [  # two lines for step 1 (last wins), two for step 2, none for step 3
        {"t": "view", "role": "police", "sub_game": 1, "step": 1, "banner": "YOUR TURN",
         "posterior": {"0,0": 0.9}, "confidence": "fuzzy"},
        {"t": "view", "role": "police", "sub_game": 1, "step": 1, "banner": "LOCKED",
         "posterior": {"5,5": 0.8}, "confidence": "exact"},
        {"t": "view", "role": "police", "sub_game": 1, "step": 2, "banner": "YOUR TURN",
         "posterior": {"1,2": 0.7}, "confidence": "fuzzy"},
        {"t": "view", "role": "police", "sub_game": 1, "step": 2, "banner": "LOCKED",
         "posterior": {"2,2": 0.6}, "confidence": "fuzzy"},
        {"t": "view", "role": "thief", "sub_game": 1, "step": 3, "posterior": {"6,6": 1.0}},
    ]
    (cop_dir / "events.jsonl").write_text(
        "".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
    document = replay.build(settings, run_id)
    frames, trace = document["frames"], document["belief_trace"]
    assert len(trace) == len(frames) == 3  # EXACTLY one belief entry per frame
    for frame, entry in zip(frames, trace, strict=True):
        assert (entry["window"], entry["step"]) == (frame["window"], frame["step"])
    assert trace[0]["ghost"] == [5, 5] and trace[0]["confidence"] == "exact"  # LAST line
    assert trace[1]["ghost"] == [2, 2]
    assert trace[2]["ghost"] is None  # no police line for step 3 (thief lines ignored)


def test_build_reads_the_shared_run_dir(settings):
    run_id = "f2-20260809-151515"
    shared = settings.shared_runs_dir(run_id)
    write_json(shared / "log_cosmos77-vs-rival_g01.json", make_log())
    write_json(shared / "result_cosmos77-vs-rival.json", make_result())
    document = replay.build(settings, run_id)
    assert document["verify"]["verdict"] == "Verified OK"
    assert document["meta"]["windows"] == 1


def test_build_flags_tampered_records(settings):
    run_id = _settled_run(settings, run_id="f2-20260809-111111", tamper=True)
    document = replay.build(settings, run_id)
    assert document["verify"]["verdict"] == "TAMPERED"
    assert not all(document["verify"]["per_step"])


def test_unsettled_run_is_refused(settings):
    run_id = "f1-20260809-121212"
    write_json(settings.runs_dir("cop", run_id) / "log_cosmos77-vs-rival_g01.json", make_log())
    with pytest.raises(replay.NotSettledError):
        replay.build(settings, run_id)


def test_route_serves_builds_and_refuses(client, settings):
    run_id = _settled_run(settings)
    response = client.get(f"/api/replays/{run_id}")
    assert response.status_code == 200
    assert response.json()["verify"]["verdict"] == "Verified OK"
    assert (settings.replays_dir / f"{run_id}.json").is_file()  # persisted

    assert client.get("/api/replays/nope-000").status_code == 404
    assert client.get("/api/replays/..%2Fescape").status_code in (404, 422)

    unsettled = "f1-20260809-131313"
    write_json(settings.runs_dir("cop", unsettled) / "log_x-vs-y_g01.json", make_log())
    assert client.get(f"/api/replays/{unsettled}").status_code == 409


def test_replay_meta_carries_the_settlement_hash(settings):
    """The fingerprint both operators read aloud after a game must be ON the page's doc."""
    import json as _json

    from cosmos_hub import replay as replay_mod

    run = "selfplay-20260101-000001"
    directory = settings.runs_dir("cop", run)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "result_x.json").write_text(_json.dumps({
        "game_id": "a-vs-b", "game_uid": "u", "final_result": {"total_score": {}},
        "mutual_agreement": {"sha256": "ab" * 32, "confirmed": True},
    }), encoding="utf-8")
    doc = replay_mod.build(settings, run)
    assert doc["meta"]["mutual_agreement"]["sha256"] == "ab" * 32
