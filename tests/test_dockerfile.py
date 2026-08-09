"""Image rail: the agent repos keep .git and the runtime ships git (rule 53).

The agents seal Step-0/report ``github_commit`` via ``git rev-parse HEAD`` only —
strip .git (or omit the git binary) and every counted run on the hub would declare
code_version "unknown", voiding the mandatory per-game commit evidence.
"""

from __future__ import annotations

import re
from pathlib import Path

DOCKERFILE = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text(encoding="utf-8")


def test_agent_git_dirs_are_never_deleted():
    assert not re.search(r"rm\s+(-\w+\s+)*[^\n]*\.git", DOCKERFILE), \
        "Dockerfile must not delete the agent repos' .git dirs (github_commit source)"


def test_runtime_stage_installs_git():
    runtime = DOCKERFILE[DOCKERFILE.index("FROM debian"):]
    install = re.search(r"apt-get install[^\n\\]*(?:\\\n[^\n\\]*)*", runtime)
    assert install and re.search(r"\bgit\b", install.group(0)), \
        "runtime image needs the git binary for `git rev-parse HEAD` at serve time"


def test_build_records_the_played_shas():
    assert "COP_COMMIT=$(git -C COSMOS77-cop rev-parse HEAD)" in DOCKERFILE
    assert "THIEF_COMMIT=$(git -C COSMOS77-thief rev-parse HEAD)" in DOCKERFILE
