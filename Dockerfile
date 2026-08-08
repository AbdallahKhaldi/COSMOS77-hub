# COSMOS77 hub — one container, three uv projects (hub + the two agent repos).
# Multi-stage: clone the agent repos at pinned refs, sync every venv with uv-managed
# pythons (hub 3.11, agents 3.12), then ship a slim runtime that keeps the same paths.

ARG COP_REPO_URL=https://github.com/AbdallahKhaldi/COSMOS77-cop.git
ARG THIEF_REPO_URL=https://github.com/AbdallahKhaldi/COSMOS77-thief.git
ARG COP_REF=main
ARG THIEF_REF=main
# Optional: a read-only token for private repos, e.g. GIT_AUTH="x-access-token:<PAT>@"
ARG GIT_AUTH=""

FROM ghcr.io/astral-sh/uv:bookworm-slim AS build
ARG COP_REPO_URL THIEF_REPO_URL COP_REF THIEF_REF GIT_AUTH
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_LINK_MODE=copy
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

RUN git clone "$(echo "$COP_REPO_URL" | sed "s#https://#https://${GIT_AUTH}#")" COSMOS77-cop \
    && git -C COSMOS77-cop checkout "$COP_REF" \
    && git clone "$(echo "$THIEF_REPO_URL" | sed "s#https://#https://${GIT_AUTH}#")" COSMOS77-thief \
    && git -C COSMOS77-thief checkout "$THIEF_REF" \
    && rm -rf COSMOS77-cop/.git COSMOS77-thief/.git

COPY . /app/COSMOS77-hub

RUN cd /app/COSMOS77-cop && uv sync --no-dev \
    && cd /app/COSMOS77-thief && uv sync --no-dev \
    && cd /app/COSMOS77-hub && uv sync --no-dev

FROM debian:bookworm-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
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
