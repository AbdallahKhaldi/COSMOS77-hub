"""Volume persistence: legacy-run migration and the direction-aware ledger sync."""

from __future__ import annotations

import json

from cosmos_hub import config, persist
from tests.conftest import make_settings


def _ledger_doc(n: int) -> dict:
    games = {f"opp{i}": {"game_id": f"g{i}"} for i in range(n)}
    return {"counted_games": games, "counted_games_played": n}


def _write(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def test_boot_migrates_legacy_repo_runs_onto_the_volume(tmp_path):
    settings = make_settings(tmp_path)
    legacy = settings.cop_repo / "runs" / "selfplay-20260808-010101"
    legacy.mkdir(parents=True)
    (legacy / "events.jsonl").write_text('{"t": "view"}\n', encoding="utf-8")
    config.ensure_dirs(settings)
    migrated = settings.runs_dir("cop", "selfplay-20260808-010101")
    assert (migrated / "events.jsonl").read_text() == '{"t": "view"}\n'
    assert legacy.is_dir()  # copied, never moved: the agent repo keeps its artifacts
    config.ensure_dirs(settings)  # idempotent second boot


def test_ledger_sync_repo_ahead_mirrors_to_volume(tmp_path):
    settings = make_settings(tmp_path)
    _write(settings.repo_ledger_file, _ledger_doc(1))
    persist.sync_ledger(settings)
    assert json.loads(settings.ledger_file.read_text()) == _ledger_doc(1)


def test_ledger_sync_volume_ahead_restores_into_the_repo(tmp_path):
    settings = make_settings(tmp_path)
    _write(settings.repo_ledger_file, _ledger_doc(0))  # freshly cloned, behind
    _write(settings.ledger_file, _ledger_doc(2))  # volume survived the redeploy
    persist.sync_ledger(settings)
    assert json.loads(settings.repo_ledger_file.read_text()) == _ledger_doc(2)
    assert json.loads(settings.ledger_file.read_text()) == _ledger_doc(2)


def test_ledger_sync_volume_backed_symlinks_repo_to_volume(tmp_path):
    settings = make_settings(tmp_path, volume_backed=True)
    _write(settings.repo_ledger_file, _ledger_doc(1))
    persist.sync_ledger(settings)
    assert settings.repo_ledger_file.is_symlink()
    assert json.loads(settings.repo_ledger_file.read_text()) == _ledger_doc(1)
    # an agent write through the repo path lands on the volume (survives restarts)
    settings.repo_ledger_file.write_text(json.dumps(_ledger_doc(2)), encoding="utf-8")
    assert json.loads(settings.ledger_file.read_text()) == _ledger_doc(2)
    persist.sync_ledger(settings)  # idempotent re-boot keeps the link


def test_ledger_sync_noop_when_no_ledger_anywhere(tmp_path):
    settings = make_settings(tmp_path)
    persist.sync_ledger(settings)
    assert not settings.ledger_file.exists()
    assert not settings.repo_ledger_file.exists()
