"""RAIL: the MCP proxy never redirects, keeps headers both ways, 502s, streams SSE."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from starlette.testclient import TestClient

from cosmos_hub.app import create_app
from cosmos_hub.proxy import _passthrough

REDIRECTS = {301, 302, 303, 307, 308}


class Body(httpx.AsyncByteStream):
    """Minimal upstream byte stream (MockTransport content= marks itself consumed)."""

    def __init__(self, *chunks: bytes):
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


def make_client_with_upstream(settings, handler):
    app = create_app(settings)
    test_client = TestClient(app, follow_redirects=False)
    app.state.proxy_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return test_client


def test_headers_preserved_both_directions_and_host_rewritten(settings):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        seen["url"] = str(request.url)
        seen["method"] = request.method
        return httpx.Response(
            406, headers={"mcp-session-id": "srv-sess", "mcp-protocol-version": "2025-06-18",
                          "content-type": "application/json"},
            stream=Body(b"Not Acceptable"),
        )

    with make_client_with_upstream(settings, handler) as client:
        response = client.get("/cop/mcp", headers={
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "mcp-session-id": "cli-sess",
            "mcp-protocol-version": "2025-03-26",
        })
    assert seen["url"] == "http://127.0.0.1:8801/mcp"
    assert seen["host"] == "127.0.0.1:8801"
    assert seen["accept"] == "application/json, text/event-stream"
    assert seen["content-type"] == "application/json"
    assert seen["mcp-session-id"] == "cli-sess"
    assert seen["mcp-protocol-version"] == "2025-03-26"
    assert response.status_code == 406  # the bare-GET ready signal survives verbatim
    assert response.headers["mcp-session-id"] == "srv-sess"
    assert response.headers["mcp-protocol-version"] == "2025-06-18"


def test_thief_path_maps_to_8802_and_delete_passes(settings):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["method"] = str(request.url), request.method
        return httpx.Response(200, headers={"content-type": "application/json"},
                              stream=Body(b'{"ok": true}'))

    with make_client_with_upstream(settings, handler) as client:
        response = client.delete("/thief/mcp")
    assert response.status_code == 200
    assert seen == {"url": "http://127.0.0.1:8802/mcp", "method": "DELETE"}


def test_no_redirect_on_trailing_slash_or_scheme_variants(settings):
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(406, stream=Body(b""))

    with make_client_with_upstream(settings, handler) as client:
        for path in ("/cop/mcp/", "/thief/mcp/", "/COP/mcp"):
            response = client.get(path)
            assert response.status_code not in REDIRECTS
            assert "location" not in response.headers
        for proto in ("http", "https"):
            response = client.post("/cop/mcp", content=b"{}",
                                   headers={"x-forwarded-proto": proto})
            assert response.status_code not in REDIRECTS


def test_plain_502_when_upstream_down(settings):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with make_client_with_upstream(settings, handler) as client:
        response = client.post("/cop/mcp", json={"jsonrpc": "2.0"})
    assert response.status_code == 502
    assert response.headers["content-type"].startswith("text/plain")
    assert "<html" not in response.text.lower()


def test_sse_headers_survive_and_body_is_not_length_buffered(settings):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream",
                     "cache-control": "no-cache, no-transform"},
            stream=Body(b"event: message\ndata: one\n\n", b"data: two\n\n"),
        )

    with make_client_with_upstream(settings, handler) as client:
        response = client.post("/cop/mcp", json={"jsonrpc": "2.0"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache, no-transform"
    assert "content-length" not in response.headers
    assert "data: one" in response.text and "data: two" in response.text


async def test_sse_chunks_pass_through_before_upstream_finishes():
    gate = asyncio.Event()
    produced_second = asyncio.Event()

    class Src(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: first\n\n"
            await gate.wait()
            produced_second.set()
            yield b"data: second\n\n"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Src())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream_client:
        upstream = await upstream_client.send(
            upstream_client.build_request("GET", "http://127.0.0.1:8801/mcp"), stream=True
        )
        chunks = _passthrough(upstream)
        first = await chunks.__anext__()
        assert first == b"data: first\n\n"  # arrived while the upstream is still blocked
        assert not produced_second.is_set()
        gate.set()
        second = await chunks.__anext__()
        assert second == b"data: second\n\n"
        with pytest.raises(StopAsyncIteration):
            await chunks.__anext__()
        await upstream.aclose()
