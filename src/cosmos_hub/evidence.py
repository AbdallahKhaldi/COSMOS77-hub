"""Sealed-evidence surface: read back the JSON a settled run actually wrote.

A counted game is judged on its sealed artifacts -- the pre-game declaration, the
per-step commits, the audit verdict -- and rules 37-38 make a FALSE declaration a
disqualification, not a deduction.  On the hosted arena those files live on the data
volume inside the container, so with no way to read them from outside we would be
trusting our own summary of our own honesty; and the summary is exactly the thing a
bug can quietly falsify.  These routes serve the bytes verbatim, admin-gated, and
confined to one run's directories, so any claim we publish can be checked against
what was sealed.  Read-only by construction: nothing here writes, deletes or runs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .admin import require_admin
from .config import Settings
from .runspec import RUN_ID_RE

router = APIRouter()
MAX_BYTES = 4_000_000  # a sealed log is ~100 KB; this only stops a pathological read


def sealed_files(settings: Settings, run_id: str) -> dict[str, Path]:
    """Every JSON a run wrote, keyed by the name callers may ask for.

    The keys ARE the allow-list: a caller can only name something this glob found,
    so no traversal or symlink games can reach a path we did not choose ourselves.
    They are role-qualified (``cop/<stamp>/log.json``) because all three candidate
    directories end in the same stamp -- keying on the bare name would let the cop's
    file hide the thief's, and evidence you cannot see is evidence you cannot check.
    """
    found: dict[str, Path] = {}
    for directory in settings.run_dirs(run_id):
        for path in sorted(directory.glob("*.json")):
            found[str(path.relative_to(settings.runs_root))] = path
    return found


@router.get("/api/admin/evidence")
async def admin_evidence(request: Request, run_id: str = "", file: str = "") -> dict[str, Any]:
    """List a run's sealed JSON, or return one of those files parsed."""
    require_admin(request)
    if not RUN_ID_RE.match(run_id):
        raise HTTPException(422, "run_id required")
    settings: Settings = request.app.state.settings
    available = sealed_files(settings, run_id)
    if not file:
        return {"run_id": run_id, "files": sorted(available)}
    path = available.get(file)
    if path is None:
        raise HTTPException(404, "unknown evidence file")
    if path.stat().st_size > MAX_BYTES:
        raise HTTPException(413, "evidence file too large to serve")
    try:
        content = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:  # a corrupt seal is itself the finding
        raise HTTPException(422, f"sealed file is not valid JSON: {exc}") from exc
    return {"run_id": run_id, "file": file, "content": content}
