"""Volume persistence: legacy-run migration and the rule-52 ledger sync (contract: Env).

ARENA-CONTRACTS: "Volume mount /data → runs/, replays/, ledger sync".  Run artifacts
are written straight to ``data_dir/runs`` (config.runs_dir/shared_runs_dir), so this
module only has to (a) migrate any runs a pre-volume hub left under ``<repo>/runs``
and (b) keep the cop repo's ledger and the volume twin agreeing.  Artifacts are
copied byte-for-byte — the hub never rewrites or pretty-prints them (read-only rail).
"""

from __future__ import annotations

import contextlib
import json
import logging
import shutil
from pathlib import Path

from .config import ROLES, Settings

log = logging.getLogger(__name__)


def migrate_legacy_runs(settings: Settings) -> int:
    """Copy runs still sitting under ``<repo>/runs`` onto the volume (idempotent).

    Copies (never moves): the agent repos own their artifacts and the hub must not
    mutate them.  A run already present on the volume is left untouched.
    """
    copied = 0
    for role in ROLES:
        legacy = settings.repo(role) / "runs"
        if not legacy.is_dir():
            continue
        for entry in sorted(legacy.iterdir()):
            target = settings.runs_dir(role, entry.name)
            if not entry.is_dir() or target.exists():
                continue
            with contextlib.suppress(OSError):
                shutil.copytree(entry, target)
                copied += 1
    if copied:
        log.info("migrated %d legacy run(s) onto the data volume", copied)
    return copied


def _counted_entries(path: Path) -> int:
    """How many settled counted series a ledger file records (-1 = unreadable/absent)."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return -1
    if not isinstance(doc, dict):
        return -1
    games = doc.get("counted_games")
    if isinstance(games, dict):
        return len(games)
    return int(doc.get("counted_games_played") or 0)


def sync_ledger(settings: Settings) -> None:
    """Direction-aware rule-52 ledger sync between the cop repo and the volume.

    Whichever copy holds MORE counted entries wins (a redeploy bakes the freshly
    cloned git-committed ledger, which may be newer than a stale volume copy — and
    vice versa after an on-hub counted run).  Ties keep the repo copy, the committed
    truth.  The winner's bytes are mirrored to the other side; on a volume-backed
    deploy the repo path then becomes a symlink to the volume twin so every runtime
    advance by the agents lands on the volume and survives a restart.
    """
    repo_path, volume_path = settings.repo_ledger_file, settings.ledger_file
    repo_n, volume_n = _counted_entries(repo_path), _counted_entries(volume_path)
    if repo_n < 0 and volume_n < 0:
        return  # no ledger anywhere yet: the agents create it on first record
    try:
        if volume_n > repo_n:  # volume is ahead (post-redeploy): restore into the repo
            repo_path.parent.mkdir(parents=True, exist_ok=True)
            repo_path.unlink(missing_ok=True)
            shutil.copyfile(volume_path, repo_path)
        elif not repo_path.is_symlink():  # repo wins (or tie): mirror it to the volume
            volume_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repo_path, volume_path)
        if settings.volume_backed and not repo_path.is_symlink():
            repo_path.unlink(missing_ok=True)
            repo_path.symlink_to(volume_path)
    except OSError:
        log.exception("ledger sync failed (repo=%s volume=%s)", repo_path, volume_path)
