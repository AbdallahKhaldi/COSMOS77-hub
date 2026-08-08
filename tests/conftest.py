"""Shared fixtures: hermetic Settings, dummy agent processes, sealed-log builders."""

from __future__ import annotations

import hashlib
import json
from typing import ClassVar

import pytest
from starlette.testclient import TestClient

import cosmos_hub.manager as manager_mod
from cosmos_hub import config
from cosmos_hub.app import create_app
from cosmos_hub.frames import canonical_str


def make_settings(tmp_path, **overrides) -> config.Settings:
    cop = tmp_path / "COSMOS77-cop"
    thief = tmp_path / "COSMOS77-thief"
    for repo in (cop, thief):
        (repo / "runs").mkdir(parents=True, exist_ok=True)
    values = dict(
        port=8080, admin_password="hub-pw", autostart=False,
        cop_repo=cop, thief_repo=thief,
        data_dir=tmp_path / "data",
        templates_dir=tmp_path / "templates",
        static_dir=tmp_path / "static",
        public_url="https://hub.test",
    )
    values.update(overrides)
    return config.Settings(**values)


@pytest.fixture
def settings(tmp_path) -> config.Settings:
    return make_settings(tmp_path)


class DummyProc:
    """Popen stand-in whose 'kill' happens via the patched os.killpg."""

    REGISTRY: ClassVar[dict[int, DummyProc]] = {}
    _next_pid = 50000

    def __init__(self, argv, cwd=None, env=None, stdout=None, stderr=None,
                 start_new_session=False):
        DummyProc._next_pid += 1
        self.pid = DummyProc._next_pid
        self.argv, self.cwd, self.rc = list(argv), cwd, None
        DummyProc.REGISTRY[self.pid] = self

    def poll(self):
        return self.rc

    def wait(self, timeout=None):
        return self.rc if self.rc is not None else 0


@pytest.fixture
def fake_procs(monkeypatch):
    DummyProc.REGISTRY.clear()

    def fake_killpg(pid, sig):
        proc = DummyProc.REGISTRY.get(pid)
        if proc is None:
            raise ProcessLookupError(pid)
        proc.rc = -sig

    monkeypatch.setattr(manager_mod.subprocess, "Popen", DummyProc)
    monkeypatch.setattr(manager_mod.os, "killpg", fake_killpg)
    return DummyProc


@pytest.fixture
def client(fake_procs, settings):
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


# -- sealed artifact builders (the agents' exact commit construction) ----------


def sealed(payload: dict, nonce: str = "aa11bb22") -> dict:
    commit = hashlib.sha256(f"{canonical_str(payload)}|{nonce}".encode()).hexdigest()
    return {"payload": payload, "nonce": nonce, "commit": commit}


def turn_payload(role: str, step: int, position: list[int], sub_game: int = 1,
                 hint: str = "hi") -> dict:
    return {
        "step": step, "role": role, "sub_game": sub_game,
        "state": f"grid=7x7;self=[{position[0]}, {position[1]}];barriers=[]",
        "position": position, "move": "MOVE:E", "intent": "truth",
        "hint": hint, "verdict": "moved",
    }


def make_log(sub_game: int = 1, my_role: str = "police", steps: int = 3,
             settled: bool = True, tamper: bool = False) -> dict:
    other = "thief" if my_role == "police" else "police"
    records = [sealed({"step": 0, "type": "system_spec", "group_name": "cosmos77"})]
    opponent = [sealed({"step": 0, "type": "system_spec", "group_name": "rival"})]
    for step in range(1, steps + 1):
        records.append(sealed(turn_payload(my_role, step, [0, step], sub_game)))
        opponent.append(sealed(turn_payload(other, step, [3, 3 + step], sub_game)))
    if tamper:
        opponent[1]["payload"]["position"] = [6, 6]
    return {
        "_schema": "test", "game_id": "cosmos77-vs-rival", "game_uid": "uid",
        "sub_game_number": sub_game,
        "summary": {
            "result": "survival", "my_role": my_role, "steps": steps,
            "reason": "max_moves", "settled": settled, "log_verified": True,
            "tampered": False,
            "row": {"score": {"cosmos77": 5, "rival": 10}, "winner_group": "rival",
                    "roles": {"cosmos77": my_role, "rival": other}},
        },
        "records": records, "opponent_records": opponent,
    }


def make_result() -> dict:
    return {
        "game_id": "cosmos77-vs-rival", "game_uid": "uid", "num_sub_games": 2,
        "final_result": {"total_score": {"cosmos77": 10, "rival": 20},
                         "winner_group": "rival"},
        "mutual_agreement": True, "sub_games": [],
    }


def write_json(path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")) + "\n",
                    encoding="utf-8")
