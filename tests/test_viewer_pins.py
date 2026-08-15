"""The viewer's trickiest rules are JS; run their node suites from the python gate."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SUITES = {
    "pacing.test.mjs": "ALL 9 PACING PINS HOLD",
    "barricade.test.mjs": "ALL 4 BARRICADE PINS HOLD",
    "timeline.test.mjs": "ALL 4 TIMELINE PINS HOLD",
}


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize(("suite", "banner"), sorted(SUITES.items()))
def test_viewer_pins_hold(suite: str, banner: str) -> None:
    """Drain policy (switch / beat / burst) and the own-cell barricade rule."""
    result = subprocess.run(
        [shutil.which("node") or "node", str(REPO / "tests" / "viewer" / suite)],
        capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert banner in result.stdout
