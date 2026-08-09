"""Env contract parsing and agent-repo detection (local dev + Docker layouts)."""

from __future__ import annotations

from pathlib import Path

from cosmos_hub import config


def test_defaults_without_env():
    settings = config.load({})
    assert settings.port == 8080
    assert settings.admin_password is None
    assert settings.standing_gids == "cosmos77"
    assert settings.autostart is True
    assert settings.public_url == "http://127.0.0.1:8080"


def test_full_env_roundtrip(tmp_path):
    env = {
        "PORT": "9001",
        "HUB_ADMIN_PASSWORD": "s3cret",
        "STANDING_GIDS": "cosmos77",
        "HUB_HARDWARE_DESC": "railway shared vcpu",
        "RAILWAY_PUBLIC_DOMAIN": "cosmos77.up.railway.app",
        "HUB_AUTOSTART": "0",
        "HUB_COP_REPO": str(tmp_path / "cop"),
        "HUB_THIEF_REPO": str(tmp_path / "thief"),
        "HUB_DATA_DIR": str(tmp_path / "vol"),
        "GMAIL_CREDENTIALS_B64": "Zm9v",
        "GMAIL_TOKEN_B64": "YmFy",
    }
    settings = config.load(env)
    assert settings.port == 9001
    assert settings.admin_password == "s3cret"
    assert settings.hardware_desc == "railway shared vcpu"
    assert settings.public_url == "https://cosmos77.up.railway.app"
    assert settings.autostart is False
    assert settings.cop_repo == tmp_path / "cop"
    assert settings.thief_repo == tmp_path / "thief"
    assert settings.data_dir == tmp_path / "vol"
    assert settings.replays_dir == tmp_path / "vol" / "replays"
    assert settings.hold_file == tmp_path / "vol" / "control" / "counted.hold"


def test_public_url_override_wins_and_is_normalized():
    env = {"HUB_PUBLIC_URL": "https://arena.example/",
           "RAILWAY_PUBLIC_DOMAIN": "ignored.example"}
    assert config.load(env).public_url == "https://arena.example"


def test_repo_detection_prefers_sibling_then_docker():
    detected = config._detect_repo({}, "HUB_COP_REPO", "COSMOS77-cop")
    sibling = config.HUB_ROOT.parent / "COSMOS77-cop"
    expected = sibling if sibling.is_dir() else Path("/app/COSMOS77-cop")
    assert detected == expected


def test_secrets_never_in_repr(tmp_path):
    settings = config.load({"GMAIL_CREDENTIALS_B64": "Zm9v", "GMAIL_TOKEN_B64": "YmFy"})
    assert "Zm9v" not in repr(settings) and "YmFy" not in repr(settings)


def test_ensure_dirs_idempotent(settings):
    config.ensure_dirs(settings)
    config.ensure_dirs(settings)
    assert settings.replays_dir.is_dir() and settings.logs_dir.is_dir()
    assert settings.hold_file.parent.is_dir() and settings.runs_root.is_dir()


def test_run_dirs_live_on_the_data_volume(settings):
    assert settings.runs_dir("cop", "x") == settings.data_dir / "runs" / "cop" / "x"
    assert settings.shared_runs_dir("x") == settings.data_dir / "runs" / "shared" / "x"
    assert settings.run_dirs("x") == [settings.shared_runs_dir("x"),
                                      settings.runs_dir("cop", "x"),
                                      settings.runs_dir("thief", "x")]
    assert settings.ledger_file == settings.data_dir / "league_ledger.json"


def test_volume_backed_flag_follows_hub_data_dir_env(tmp_path):
    assert config.load({}).volume_backed is False
    assert config.load({"HUB_DATA_DIR": str(tmp_path / "vol")}).volume_backed is True
