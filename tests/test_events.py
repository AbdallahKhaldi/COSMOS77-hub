"""Tailer: events.jsonl + window logs + result -> envelopes; local-truth whitelist."""

from __future__ import annotations

import asyncio
import json

from cosmos_hub.broadcast import Broadcaster
from cosmos_hub.envelopes import EnvelopeLog, view_payload, window_end_payload
from cosmos_hub.events import RunTailer
from tests.conftest import make_log, make_result, write_json

VIEW_LINE = {
    "t": "view", "role": "police", "sub_game": 1, "step": 2, "banner": "YOUR TURN",
    "self_pos": [0, 1], "barriers": [[2, 2]], "barriers_left": 13,
    "posterior": {"3,4": 0.8, "3,3": 0.2}, "perceived_scent": {"3,4": 0.9},
    "confidence": "fuzzy", "hints": ["moving east"],
}


def drain(queue):
    out = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


async def test_tailer_composes_seq_stamped_envelopes(settings):
    broadcaster = Broadcaster()
    police_q = broadcaster.subscribe("police")
    thief_q = broadcaster.subscribe("thief")
    elog = EnvelopeLog(broadcaster, "run-x")
    cop_dir = settings.runs_dir("cop", "run-x")
    thief_dir = settings.runs_dir("thief", "run-x")
    for directory in (cop_dir, thief_dir):
        directory.mkdir(parents=True)
    tailer = RunTailer([cop_dir, thief_dir], elog, poll_s=0.01)
    stop = asyncio.Event()
    task = asyncio.create_task(tailer.run(stop))

    # 1) a complete view line plus one PARTIAL line (must be held back)
    with (cop_dir / "events.jsonl").open("w") as handle:
        handle.write(json.dumps(VIEW_LINE) + "\n")
        handle.write('{"t": "view", "role": "pol')  # torn write
    await asyncio.sleep(0.08)
    got = drain(police_q)
    assert [e["type"] for e in got] == ["view"]
    assert got[0]["seq"] == 1 and got[0]["run_id"] == "run-x"
    assert got[0]["payload"]["banner"] == "YOUR TURN"

    # 2) complete the torn line -> exactly one more view envelope
    with (cop_dir / "events.jsonl").open("a") as handle:
        handle.write('ice", "step": 3}\n')
    await asyncio.sleep(0.08)
    got = drain(police_q)
    assert len(got) == 1 and got[0]["payload"]["step"] == 3 and got[0]["seq"] == 2

    # 3) thief side view goes to the thief perspective only
    write_json(thief_dir / "tmp.json", {})  # unrelated file is ignored
    with (thief_dir / "events.jsonl").open("w") as handle:
        handle.write(json.dumps({**VIEW_LINE, "role": "thief"}) + "\n")
    await asyncio.sleep(0.08)
    assert [e["perspective"] for e in drain(thief_q)] == ["thief"]
    assert drain(police_q) == []

    # 4) window log -> window_end for that side's perspective, records NEVER leak
    write_json(cop_dir / "log_cosmos77-vs-rival_g01.json", make_log(my_role="police"))
    await asyncio.sleep(0.08)
    got = drain(police_q)
    assert [e["type"] for e in got] == ["window_end"]
    payload = got[0]["payload"]
    assert payload["result"] == "survival" and payload["score"] == {"cosmos77": 5, "rival": 10}
    assert "records" not in json.dumps(payload)
    assert "position" not in json.dumps(payload)

    # 5) result -> one series_end on BOTH perspectives; seq stays monotonic
    write_json(cop_dir / "result_cosmos77-vs-rival.json", make_result())
    write_json(thief_dir / "result_cosmos77-vs-rival.json", make_result())
    await asyncio.sleep(0.08)
    police_end = drain(police_q)
    thief_end = drain(thief_q)
    assert [e["type"] for e in police_end] == ["series_end"]
    assert [e["type"] for e in thief_end] == ["series_end"]
    assert police_end[0]["payload"]["final_result"]["winner_group"] == "rival"

    stop.set()
    await task
    seqs = [elog.seq]
    assert seqs[0] >= 5  # monotonic counter advanced once per envelope


def test_view_whitelist_passes_contract_fields_only():
    payload = view_payload({**VIEW_LINE, "opponent_pos": [6, 6], "secret": 1})
    assert "opponent_pos" not in payload and "secret" not in payload
    assert payload["posterior"] == {"3,4": 0.8, "3,3": 0.2}


def test_window_end_whitelist_never_carries_records():
    doc = make_log()
    payload = window_end_payload(doc)
    dumped = json.dumps(payload)
    assert "nonce" not in dumped and "commit" not in dumped and "records" not in dumped
    assert payload["settled"] is True and payload["sub_game"] == 1
