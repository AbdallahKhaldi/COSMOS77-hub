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
    """Rule-52 ledger sync: the VOLUME is the runtime home; the repo file stays committed.

    An earlier revision symlinked the repo path onto the volume twin so runtime
    advances would survive redeploys — and quietly made ``git status`` in the cop
    repo report a typechange, which the rule-53 clean-tree gate correctly reads as
    dirty: the counted run REFUSES to arm on the very machine built to run it.
    Now nothing under the repo is ever replaced: the agents write the volume twin
    directly (``COSMOS_LEDGER_FILE`` in their spawn env), a fresh redeploy seeds the
    volume from the committed file when the repo is ahead, and a volume that is
    ahead is only LOGGED — committing it back is the close-out step, a human act.
    """
    repo_path, volume_path = settings.repo_ledger_file, settings.ledger_file
    try:
        if repo_path.is_symlink():  # repair the earlier design: restore the committed file
            target_bytes = volume_path.read_bytes() if volume_path.exists() else b"{}"
            repo_path.unlink()
            repo_path.write_bytes(target_bytes)
            _restore_committed(settings, repo_path)
        repo_n, volume_n = _counted_entries(repo_path), _counted_entries(volume_path)
        if repo_n < 0 and volume_n < 0:
            return  # no ledger anywhere yet: the agents create it on first record
        if repo_n > volume_n:  # fresh redeploy carrying a newer committed ledger
            volume_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repo_path, volume_path)
        elif volume_n > repo_n:
            log.info("volume ledger is ahead of the committed one (%d > %d): "
                     "commit it back during close-out", volume_n, repo_n)
    except OSError:
        log.exception("ledger sync failed (repo=%s volume=%s)", repo_path, volume_path)


def _restore_committed(settings: Settings, repo_path: Path) -> None:
    """Best-effort ``git checkout`` of the ledger so the tree returns to CLEAN."""
    import subprocess

    with contextlib.suppress(Exception):
        subprocess.run(
            ["git", "checkout", "--", "artifacts/league_ledger.json"],
            cwd=str(settings.cop_repo), capture_output=True, timeout=30, check=False,
        )
