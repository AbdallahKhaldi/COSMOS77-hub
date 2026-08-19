"""Admin auth: HMAC cookie sessions, 401 walls, and the run/stop/logs surface."""

from __future__ import annotations

from starlette.testclient import TestClient

from cosmos_hub import admin
from cosmos_hub.app import create_app
from tests.conftest import make_settings

PROTECTED = (
    ("post", "/api/admin/run", {"kind": "selfplay"}),
    ("post", "/api/admin/stop", {}),
    ("get", "/api/admin/logs", None),
    ("post", "/api/admin/report-dry-run", {"run_id": "x"}),
)


def test_all_admin_endpoints_401_without_cookie(client):
    for method, url, body in PROTECTED:
        response = getattr(client, method)(url, json=body) if body is not None \
            else client.get(url)
        assert response.status_code == 401, url


def test_wrong_password_401_and_no_cookie(client):
    response = client.post("/api/admin/login", json={"password": "nope"})
    assert response.status_code == 401
    assert admin.COOKIE not in client.cookies


def test_admin_disabled_when_no_password_configured(tmp_path, fake_procs):
    app = create_app(make_settings(tmp_path, admin_password=None))
    with TestClient(app) as client:
        response = client.post("/api/admin/login", json={"password": ""})
        assert response.status_code == 503


def test_login_cookie_secure_on_https_deploys_only(client, tmp_path, fake_procs):
    response = client.post("/api/admin/login", json={"password": "hub-pw"})
    header = response.headers["set-cookie"].lower()
    assert "secure" in header and "httponly" in header  # settings.public_url is https
    plain = make_settings(tmp_path, public_url="http://127.0.0.1:8080")
    with TestClient(create_app(plain)) as http_client:
        response = http_client.post("/api/admin/login", json={"password": "hub-pw"})
        assert "secure" not in response.headers["set-cookie"].lower()  # local http dev


def test_login_sets_cookie_and_unlocks(client, fake_procs):
    assert client.post("/api/admin/login", json={"password": "hub-pw"}).status_code == 200
    assert admin.COOKIE in client.cookies

    response = client.post("/api/admin/run", json={"kind": "selfplay", "windows": 2})
    assert response.status_code == 200
    run_id = response.json()["run_id"]
    assert run_id.startswith("selfplay-")

    busy = client.post("/api/admin/run", json={"kind": "selfplay"})
    assert busy.status_code == 409  # one active run at a time

    stopped = client.post("/api/admin/stop", json={})
    assert stopped.status_code == 200 and stopped.json()["stopped"] is True

    logs = client.get("/api/admin/logs")
    assert logs.status_code == 200 and any("standing" in n for n in logs.json()["logs"])
    one = client.get("/api/admin/logs", params={"name": logs.json()["logs"][0]})
    assert one.status_code == 200 and "tail" in one.json()


def test_admin_run_passes_single_url_and_scent_model_to_both_serves(client):
    client.post("/api/admin/login", json={"password": "hub-pw"})
    response = client.post("/api/admin/run", json={
        "kind": "f2", "opponent_gid": "rival",
        "their_single_url": "https://one.example/mcp",
        "scent_model": "multiplicative_book_v1"})
    assert response.status_code == 200
    for role in ("cop", "thief"):
        argv = client.app.state.manager.procs[role].argv
        assert argv[argv.index("--peer-url") + 1] == "https://one.example/mcp"
        assert argv[argv.index("--scent-model") + 1] == "multiplicative_book_v1"
    client.post("/api/admin/stop", json={})
    bad = client.post("/api/admin/run", json={"kind": "f2", "opponent_gid": "rival",
                                              "their_single_url": "https://one.example/mcp",
                                              "scent_model": "nope_v0"})
    assert bad.status_code == 409  # RunRefusedError surfaces as 409 on the admin surface


def test_forged_or_expired_cookie_rejected(client):
    client.cookies.set(admin.COOKIE, "123.deadbeef")
    assert client.post("/api/admin/stop", json={}).status_code == 401
    stale = admin.make_token(now=1.0)  # far past the TTL
    client.cookies.set(admin.COOKIE, stale)
    assert client.post("/api/admin/stop", json={}).status_code == 401


def test_token_roundtrip_and_ttl():
    token = admin.make_token(now=1000.0)
    assert admin.token_valid(token, now=1000.0 + admin.SESSION_TTL_S)
    assert not admin.token_valid(token, now=1000.0 + admin.SESSION_TTL_S + 1)
    assert not admin.token_valid("garbage")
    assert not admin.token_valid("")


def test_report_dry_run_needs_settled_result(client):
    client.post("/api/admin/login", json={"password": "hub-pw"})
    response = client.post("/api/admin/report-dry-run", json={"run_id": "missing-run"})
    assert response.status_code == 404
    bad = client.post("/api/admin/report-dry-run", json={"run_id": "../escape"})
    assert bad.status_code == 422


def test_admin_f2_accepts_a_short_window_count(client):
    # pairing smoke after an opponent fix: 2 windows = one per role direction
    client.post("/api/admin/login", json={"password": "hub-pw"})
    bad = client.post("/api/admin/run", json={"kind": "f2", "opponent_gid": "rival",
                                              "windows": 9})
    assert bad.status_code == 409  # admin maps RunRefusedError to 409
    response = client.post("/api/admin/run", json={
        "kind": "f2", "opponent_gid": "rival", "windows": 2,
        "their_cop_url": "https://c.example/mcp", "their_thief_url": "https://t.example/mcp"})
    assert response.status_code == 200
    argv = client.app.state.manager.procs["cop"].argv
    assert argv[argv.index("--windows") + 1] == "2"
