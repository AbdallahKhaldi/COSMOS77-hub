"""Materialize Gmail OAuth secrets from env to the agent repos' expected paths.

The agent repos read ``credentials.json`` / ``token.json`` from their own root
(``cosmos77_cop.report.gmail:CREDENTIALS_FILE``).  Railway carries them as base64
env vars; at boot we decode to both repos with mode 0600.  Values are NEVER logged.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os

from .config import ROLES, Settings

log = logging.getLogger(__name__)
_FILES = (("gmail_credentials_b64", "credentials.json"), ("gmail_token_b64", "token.json"))


def _write_secret(path: str, decoded: bytes) -> None:
    """Write *decoded* to *path* with owner-only permissions, atomically enough for boot."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, decoded)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


def materialize(settings: Settings) -> int:
    """Decode the two Gmail env blobs into both agent repos.  Returns files written."""
    written = 0
    for attr, filename in _FILES:
        blob = getattr(settings, attr)
        if not blob:
            continue
        try:
            decoded = base64.b64decode(blob, validate=True)
        except (binascii.Error, ValueError):
            log.warning("secret %s is not valid base64; skipped (value not logged)", attr)
            continue
        for role in ROLES:
            repo = settings.repo(role)
            if not repo.is_dir():
                continue
            _write_secret(str(repo / filename), decoded)
            written += 1
    if written:
        log.info("materialized %d Gmail secret file(s) at mode 0600", written)
    return written
