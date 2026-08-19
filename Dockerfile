# COSMOS77 hub — one container, three uv projects (hub + the two agent repos).
# Multi-stage: clone the agent repos at pinned refs, sync every venv with uv-managed
# pythons (hub 3.11, agents 3.12), then ship a slim runtime that keeps the same paths.

ARG COP_REPO_URL=https://github.com/AbdallahKhaldi/COSMOS77-cop.git
ARG THIEF_REPO_URL=https://github.com/AbdallahKhaldi/COSMOS77-thief.git
ARG COP_REF=3380636bb14ee627ac3fd6f0ad4a8ed03a8cb025
ARG THIEF_REF=bc628b3bc160d02d7fd8a1c27c87fb0ccece5764
# Optional: a read-only token for private repos, e.g. GIT_AUTH="x-access-token:<PAT>@"
ARG GIT_AUTH=""

FROM ghcr.io/astral-sh/uv:bookworm-slim AS build
ARG COP_REPO_URL THIEF_REPO_URL COP_REF THIEF_REF GIT_AUTH
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_LINK_MODE=copy
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# The .git dirs are KEPT: the agents seal Step-0/report `github_commit` via
# `git rev-parse HEAD` (rule 53 — bare 40-hex, no env/file fallback exists), so
# stripping them would make every counted run declare "unknown".  Image size is the
# accepted cost.  COMMITS records the played SHAs for operator visibility (kept
# OUTSIDE the repos so `git status` stays clean for the dirty-tree counted check).
RUN git clone "$(echo "$COP_REPO_URL" | sed "s#https://#https://${GIT_AUTH}#")" COSMOS77-cop \
    && git -C COSMOS77-cop checkout "$COP_REF" \
    && git clone "$(echo "$THIEF_REPO_URL" | sed "s#https://#https://${GIT_AUTH}#")" COSMOS77-thief \
    && git -C COSMOS77-thief checkout "$THIEF_REF" \
    && { echo "COP_COMMIT=$(git -C COSMOS77-cop rev-parse HEAD)"; \
         echo "THIEF_COMMIT=$(git -C COSMOS77-thief rev-parse HEAD)"; } > /app/COMMITS \
    && cat /app/COMMITS

COPY . /app/COSMOS77-hub

RUN cd /app/COSMOS77-cop && uv sync --no-dev \
    && cd /app/COSMOS77-thief && uv sync --no-dev \
    && cd /app/COSMOS77-hub && uv sync --no-dev

FROM debian:bookworm-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
# git ships in the runtime image: the agents run `git rev-parse HEAD` at serve time
# to seal the counted github_commit (rule 53) — without the binary the kept .git
# dirs above would still resolve to "unknown".
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/uv/python /opt/uv/python
COPY --from=build /app /app

ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_NO_SYNC=1 \
    HUB_COP_REPO=/app/COSMOS77-cop \
    HUB_THIEF_REPO=/app/COSMOS77-thief \
    HUB_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

WORKDIR /app/COSMOS77-hub
EXPOSE 8080
CMD ["sh", "-c", "uv run uvicorn cosmos_hub.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
