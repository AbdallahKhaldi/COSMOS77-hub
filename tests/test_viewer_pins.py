"""The viewer's drain policy is JS; run its node suite from the python gate."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SUITE = REPO / "tests" / "viewer" / "pacing.test.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_viewer_pacing_pins_hold() -> None:
    """Feed-switch fast-forward, the paced beat, and burst tiers stay pinned."""
    result = subprocess.run(
        [shutil.which("node") or "node", str(SUITE)],
        capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ALL 8 PACING PINS HOLD" in result.stdout
