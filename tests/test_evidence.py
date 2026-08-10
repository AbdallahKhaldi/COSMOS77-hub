"""Sealed evidence: admin-gated, allow-listed by glob, and served verbatim."""

from __future__ import annotations

import json

from cosmos_hub.evidence import sealed_files


def _seal(settings, run_id: str, name: str, body: dict) -> None:
    directory = settings.runs_dir("cop", run_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(json.dumps(body), encoding="utf-8")


def _login(client) -> None:
    assert client.post("/api/admin/login", json={"password": "hub-pw"}).status_code == 200


def test_evidence_401s_without_a_session(client):
    assert client.get("/api/admin/evidence?run_id=selfplay-20260101-000000").status_code == 401


def test_a_malformed_run_id_is_refused_before_touching_the_disk(client):
    _login(client)
    assert client.get("/api/admin/evidence?run_id=../../etc").status_code == 422


def test_listing_names_every_sealed_json_of_that_run(client, settings):
    run = "selfplay-20260101-000000"
    _seal(settings, run, "log_cosmos77_g01.json", {"declaration": {"llm_model": "template"}})
    _seal(settings, run, "result_g01.json", {"outcome": "survival"})
    _login(client)
    body = client.get(f"/api/admin/evidence?run_id={run}").json()
    assert body["files"] == [f"cop/{run}/log_cosmos77_g01.json",
                             f"cop/{run}/result_g01.json"]


def test_a_named_file_comes_back_parsed_and_unaltered(client, settings):
    run, sealed_body = "selfplay-20260101-000000", {"declaration": {"llm_model": "gemini-x"}}
    _seal(settings, run, "log_cosmos77_g01.json", sealed_body)
    _login(client)
    body = client.get(
        "/api/admin/evidence",
        params={"run_id": run, "file": f"cop/{run}/log_cosmos77_g01.json"},
    ).json()
    assert body["content"] == sealed_body


def test_a_file_outside_the_glob_cannot_be_named(client, settings):
    """The listing IS the allow-list, so traversal has nothing to resolve against."""
    run = "selfplay-20260101-000000"
    _seal(settings, run, "log_cosmos77_g01.json", {"ok": True})
    secret = settings.data_dir / "secret.json"
    secret.write_text(json.dumps({"api_key": "leaked"}), encoding="utf-8")
    _login(client)
    for attempt in ("../secret.json", f"cop/{run}/../../../secret.json", str(secret)):
        response = client.get("/api/admin/evidence", params={"run_id": run, "file": attempt})
        assert response.status_code == 404, attempt


def test_corrupt_json_is_reported_rather_than_silently_swallowed(client, settings):
    run = "selfplay-20260101-000000"
    directory = settings.runs_dir("cop", run)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "log_cosmos77_g01.json").write_text("{not json", encoding="utf-8")
    _login(client)
    response = client.get(
        "/api/admin/evidence",
        params={"run_id": run, "file": f"cop/{run}/log_cosmos77_g01.json"},
    )
    assert response.status_code == 422
    assert "not valid JSON" in response.json()["detail"]


def test_identically_named_role_files_never_hide_each_other(settings):
    """Both sides seal a file of the same name; the listing must show BOTH."""
    run = "selfplay-20260101-000000"
    for role in ("cop", "thief"):
        directory = settings.runs_dir(role, run)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "log_same.json").write_text("{}", encoding="utf-8")
    assert sorted(sealed_files(settings, run)) == [f"cop/{run}/log_same.json",
                                                   f"thief/{run}/log_same.json"]
