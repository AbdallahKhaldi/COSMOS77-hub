"""Environment contract and filesystem layout (contract: Env contract / Topology).

The hub never imports the agent repos — it only needs their directories to spawn
``uv run`` subprocesses in.  Local dev finds them side-by-side (``../COSMOS77-cop``);
the Docker image puts all three under ``/app``.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

HUB_ROOT = Path(__file__).resolve().parents[2]
COP_PORT = 8801
THIEF_PORT = 8802
ROLES = ("cop", "thief")


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of everything the hub reads from the environment."""

    port: int = 8080
    admin_password: str | None = None
    standing_gids: str = "cosmos77"
    hardware_desc: str | None = None
    public_url: str = "http://127.0.0.1:8080"
    autostart: bool = True
    cop_repo: Path = HUB_ROOT.parent / "COSMOS77-cop"
    thief_repo: Path = HUB_ROOT.parent / "COSMOS77-thief"
    data_dir: Path = HUB_ROOT / "data"
    templates_dir: Path = HUB_ROOT / "templates"
    static_dir: Path = HUB_ROOT / "static"
    gmail_credentials_b64: str | None = field(default=None, repr=False)
    gmail_token_b64: str | None = field(default=None, repr=False)

    def repo(self, role: str) -> Path:
        """Working directory of the agent repo playing *role* (``cop`` | ``thief``)."""
        return self.cop_repo if role == "cop" else self.thief_repo

    def runs_dir(self, role: str, stamp: str) -> Path:
        """Artifact directory a run writes under *role*'s repo (each side keeps its own)."""
        return self.repo(role) / "runs" / stamp

    @property
    def replays_dir(self) -> Path:
        """Settled bird's-eye replays live on the hub volume, never in the agent repos."""
        return self.data_dir / "replays"

    @property
    def logs_dir(self) -> Path:
        """Captured stdout/stderr of spawned agent processes (admin log tail)."""
        return self.data_dir / "logs"

    @property
    def hold_file(self) -> Path:
        """Presence = an SSH counted run owns the agent ports; the manager stands down."""
        return self.data_dir / "control" / "counted.hold"


def _detect_repo(env: Mapping[str, str], key: str, name: str) -> Path:
    """Resolve an agent repo: env override, side-by-side sibling, then Docker layout."""
    override = env.get(key)
    if override:
        return Path(override)
    sibling = HUB_ROOT.parent / name
    if sibling.is_dir():
        return sibling
    return Path("/app") / name


def load(env: Mapping[str, str] | None = None) -> Settings:
    """Build :class:`Settings` from *env* (defaults to ``os.environ``)."""
    env = os.environ if env is None else env
    port = int(env.get("PORT", "8080"))
    domain = env.get("RAILWAY_PUBLIC_DOMAIN")
    default_public = f"https://{domain}" if domain else f"http://127.0.0.1:{port}"
    return Settings(
        port=port,
        admin_password=env.get("HUB_ADMIN_PASSWORD") or None,
        standing_gids=env.get("STANDING_GIDS", "cosmos77"),
        hardware_desc=env.get("HUB_HARDWARE_DESC") or None,
        public_url=env.get("HUB_PUBLIC_URL", default_public).rstrip("/"),
        autostart=env.get("HUB_AUTOSTART", "1") not in ("0", "false", "no"),
        cop_repo=_detect_repo(env, "HUB_COP_REPO", "COSMOS77-cop"),
        thief_repo=_detect_repo(env, "HUB_THIEF_REPO", "COSMOS77-thief"),
        data_dir=Path(env.get("HUB_DATA_DIR", str(HUB_ROOT / "data"))),
        templates_dir=Path(env.get("HUB_TEMPLATES_DIR", str(HUB_ROOT / "templates"))),
        static_dir=Path(env.get("HUB_STATIC_DIR", str(HUB_ROOT / "static"))),
        gmail_credentials_b64=env.get("GMAIL_CREDENTIALS_B64") or None,
        gmail_token_b64=env.get("GMAIL_TOKEN_B64") or None,
    )


def ensure_dirs(settings: Settings) -> None:
    """Create the hub-owned data directories (volume-safe, idempotent)."""
    for path in (settings.replays_dir, settings.logs_dir, settings.hold_file.parent):
        path.mkdir(parents=True, exist_ok=True)
