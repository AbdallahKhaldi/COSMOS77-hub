"""Strict MCP reverse proxy: /cop/mcp -> :8801, /thief/mcp -> :8802, /mcp -> :8803.

Non-negotiable contract (recon `urls`): never redirect at the published paths, pass
GET/POST/DELETE, preserve Accept / Content-Type / mcp-session-id / mcp-protocol-version
in BOTH directions, rewrite Host to the upstream bind, stream SSE unbuffered, answer a
plain 502 when the upstream subprocess is down, and add no auth, cookies, or styled
errors.  The 406-to-bare-GET readiness probe must pass through verbatim.  ``/mcp``
serves single-URL opponents via the window-parity sparring relay (same contract).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Request
from starlette.background import BackgroundTask
from starlette.responses import PlainTextResponse, Response, StreamingResponse

from .argvs import PORTS
from .config import RELAY_PORT

router = APIRouter()
_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}
_SKIP_REQ = _HOP | {"host", "content-length"}
_SKIP_RESP = _HOP | {"date", "server"}


def make_client() -> httpx.AsyncClient:
    """Upstream client: no redirects ever; unlimited read time for standing SSE streams."""
    timeout = httpx.Timeout(connect=5.0, read=None, write=30.0, pool=5.0)
    return httpx.AsyncClient(timeout=timeout, follow_redirects=False)


def _request_headers(request: Request, port: int) -> list[tuple[str, str]]:
    """Forward every header except hop-by-hop; rewrite Host to the upstream bind."""
    headers = [(k, v) for k, v in request.headers.items() if k.lower() not in _SKIP_REQ]
    headers.append(("host", f"127.0.0.1:{port}"))
    return headers


def _response_headers(upstream: httpx.Response) -> list[tuple[str, str]]:
    """Pass upstream headers back minus hop-by-hop (session + protocol headers survive)."""
    return [(k, v) for k, v in upstream.headers.items() if k.lower() not in _SKIP_RESP]


async def _passthrough(upstream: httpx.Response) -> AsyncIterator[bytes]:
    """Yield raw upstream bytes as they arrive — no buffering, no re-encoding."""
    try:
        async for chunk in upstream.aiter_raw():
            yield chunk
    except httpx.HTTPError:  # upstream died mid-stream: end the stream, nothing to resend
        return


async def relay(request: Request, port: int) -> Response:
    """Proxy one request to the agent bound on 127.0.0.1:*port* at path /mcp."""
    client: httpx.AsyncClient = request.app.state.proxy_client
    url = httpx.URL(f"http://127.0.0.1:{port}/mcp", query=request.url.query.encode() or None)
    upstream_request = client.build_request(
        request.method, url,
        headers=_request_headers(request, port),
        content=await request.body(),
    )
    try:
        upstream = await client.send(upstream_request, stream=True, follow_redirects=False)
    except httpx.HTTPError:
        return PlainTextResponse("upstream down", status_code=502)
    return StreamingResponse(
        _passthrough(upstream),
        status_code=upstream.status_code,
        headers=dict(_response_headers(upstream)),
        background=BackgroundTask(upstream.aclose),
    )


@router.api_route("/cop/mcp", methods=["GET", "POST", "DELETE"], include_in_schema=False)
async def cop_mcp(request: Request) -> Response:
    """Published cop endpoint (opponents dial this)."""
    return await relay(request, PORTS["cop"])


@router.api_route("/thief/mcp", methods=["GET", "POST", "DELETE"], include_in_schema=False)
async def thief_mcp(request: Request) -> Response:
    """Published thief endpoint (opponents dial this)."""
    return await relay(request, PORTS["thief"])


@router.api_route("/mcp", methods=["GET", "POST", "DELETE"], include_in_schema=False)
async def single_mcp(request: Request) -> Response:
    """Published single-URL endpoint (window-parity relay routes odd/even windows)."""
    return await relay(request, RELAY_PORT)
