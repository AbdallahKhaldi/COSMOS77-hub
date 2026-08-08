"""Repo rail: every source file stays at or under 150 lines (contract: Hard rails)."""

from __future__ import annotations

from pathlib import Path

import cosmos_hub

CAP = 150


def test_every_src_file_within_cap():
    package_dir = Path(cosmos_hub.__file__).parent
    offenders = {}
    for path in sorted(package_dir.glob("*.py")):
        lines = len(path.read_text(encoding="utf-8").splitlines())
        if lines > CAP:
            offenders[path.name] = lines
    assert not offenders, f"files over the {CAP}-line cap: {offenders}"
