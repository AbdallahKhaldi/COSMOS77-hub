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


def test_ledger_sync_volume_ahead_leaves_the_committed_repo_file_alone(tmp_path):
    """Overwriting the repo copy would dirty the tree the counted gate requires clean;
    a volume that is ahead is LOGGED for close-out, never written into the repo."""
    settings = make_settings(tmp_path)
    _write(settings.repo_ledger_file, _ledger_doc(0))  # freshly cloned, behind
    _write(settings.ledger_file, _ledger_doc(2))  # volume survived the redeploy
    persist.sync_ledger(settings)
    assert json.loads(settings.repo_ledger_file.read_text()) == _ledger_doc(0)
    assert json.loads(settings.ledger_file.read_text()) == _ledger_doc(2)


def test_ledger_sync_never_symlinks_and_repairs_an_old_link(tmp_path):
    """The symlink design made git report a typechange -> rule 53 refused the counted
    run ON THE HUB. Boot now restores a regular file and never links again."""
    settings = make_settings(tmp_path, volume_backed=True)
    _write(settings.ledger_file, _ledger_doc(2))
    settings.repo_ledger_file.parent.mkdir(parents=True, exist_ok=True)
    settings.repo_ledger_file.symlink_to(settings.ledger_file)  # the old design
    persist.sync_ledger(settings)
    assert not settings.repo_ledger_file.is_symlink(), "the link must be repaired"
    persist.sync_ledger(settings)  # idempotent
    assert not settings.repo_ledger_file.is_symlink()


def test_spawn_env_points_agents_at_the_volume_ledger(tmp_path):
    from cosmos_hub import seeds

    env = seeds.spawn_env(ledger_file="/data/league_ledger.json")
    assert env["COSMOS_LEDGER_FILE"] == "/data/league_ledger.json"
    assert "COSMOS_LEDGER_FILE" not in seeds.spawn_env()


def test_ledger_sync_noop_when_no_ledger_anywhere(tmp_path):
    settings = make_settings(tmp_path)
    persist.sync_ledger(settings)
    assert not settings.ledger_file.exists()
    assert not settings.repo_ledger_file.exists()
