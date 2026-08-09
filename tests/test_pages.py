"""Pages + status surface: health, template fallbacks, no Swagger at /docs."""

from __future__ import annotations

import base64

from starlette.testclient import TestClient

from cosmos_hub import secrets_boot
from cosmos_hub.app import create_app
from tests.conftest import make_settings


def test_health_is_plain_ok(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.text == "ok"


def test_public_pages_respond_html(client):
    for path in ("/", "/replay/f1-20260809-101010", "/docs", "/league", "/admin"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.headers["content-type"].startswith("text/html")


def test_docs_is_not_openapi(client):
    assert client.get("/openapi.json").status_code == 404
    assert "swagger" not in client.get("/docs").text.lower()


def test_template_files_win_over_placeholders(tmp_path, fake_procs):
    settings = make_settings(tmp_path)
    settings.templates_dir.mkdir(parents=True)
    (settings.templates_dir / "index.html").write_text("<html><body>TRACK-C</body></html>")
    with TestClient(create_app(settings)) as client:
        assert "TRACK-C" in client.get("/").text


def test_api_status_shape(client):
    body = client.get("/api/status").json()
    assert body["state"] == "standing"
    assert body["run"] is None
    assert set(body["agents"]) == {"cop", "thief", "relay"}
    assert body["endpoints"]["cop"] == "https://hub.test/cop/mcp"
    assert body["endpoints"]["thief"] == "https://hub.test/thief/mcp"
    assert body["endpoints"]["single"] == "https://hub.test/mcp"


def test_api_runs_lists_and_flags(client, settings):
    from tests.conftest import make_log, make_result, write_json

    run_dir = settings.runs_dir("cop", "f1-20260809-090909")
    write_json(run_dir / "log_a-vs-b_g01.json", make_log())
    write_json(run_dir / "result_a-vs-b.json", make_result())
    runs = client.get("/api/runs").json()["runs"]
    assert runs[0]["run_id"] == "f1-20260809-090909"
    assert runs[0]["settled"] is True and runs[0]["windows_logged"] == 1


def test_gmail_secrets_materialize_0600(tmp_path):
    settings = make_settings(
        tmp_path,
        gmail_credentials_b64=base64.b64encode(b'{"installed": {}}').decode(),
        gmail_token_b64=base64.b64encode(b'{"token": "t"}').decode(),
    )
    written = secrets_boot.materialize(settings)
    assert written == 4  # two files x two repos
    for repo in (settings.cop_repo, settings.thief_repo):
        for name in ("credentials.json", "token.json"):
            path = repo / name
            assert path.is_file()
            assert (path.stat().st_mode & 0o777) == 0o600
    assert (settings.cop_repo / "credentials.json").read_bytes() == b'{"installed": {}}'


def test_bad_base64_is_skipped_not_fatal(tmp_path):
    settings = make_settings(tmp_path, gmail_credentials_b64="!!notb64!!")
    assert secrets_boot.materialize(settings) == 0
