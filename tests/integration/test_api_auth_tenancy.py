import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tenderline import ratelimit
from tenderline.api.app import create_app
from tenderline.config import get_settings
from tenderline.db import owner_session
from tenderline.security import create_token


@pytest.fixture()
def client(migrated_db):
    ratelimit.reset()
    with TestClient(create_app(), raise_server_exceptions=False) as c:
        yield c


def auth_headers(user_id):
    return {"Authorization": f"Bearer {create_token(user_id)}"}


def add_user(org_id, role):
    uid = uuid.uuid4()
    with owner_session() as s:
        s.execute(text("INSERT INTO users (id, login) VALUES (:i, :l)"), {"i": uid, "l": f"u-{uid.hex[:8]}"})
        s.execute(
            text("INSERT INTO memberships (organisation_id, user_id, role) VALUES (:o,:u,:r)"),
            {"o": org_id, "u": uid, "r": role},
        )
    return uid


def test_error_model_and_request_id(client):
    r = client.get("/v1/me")
    assert r.status_code == 401
    err = r.json()["error"]
    assert err["code"] == "unauthorized" and err["request_id"] == r.headers["X-Request-ID"]
    r = client.get("/v1/me", headers={"X-Request-ID": "abc-123", **{"Authorization": "Bearer nope"}})
    assert r.json()["error"]["code"] == "invalid_token" and r.headers["X-Request-ID"] == "abc-123"


def test_validation_errors_use_the_same_model(client, make_org):
    a = make_org()
    r = client.patch(f"/v1/organisations/{a['org_id']}", json={"name": "x"}, headers=auth_headers(a["user_id"]))
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_tenant_a_cannot_read_or_change_tenant_b(client, make_org):
    a, b = make_org("Tenant A"), make_org("Tenant B")
    # A's user addressing B's organisation: 404, indistinguishable from a missing organisation.
    assert client.get(f"/v1/organisations/{b['org_id']}", headers=auth_headers(a["user_id"])).status_code == 404
    r = client.patch(f"/v1/organisations/{b['org_id']}", json={"name": "Hacked"}, headers=auth_headers(a["user_id"]))
    assert r.status_code == 404
    assert client.get(f"/v1/organisations/{b['org_id']}/members", headers=auth_headers(a["user_id"])).status_code == 404
    with owner_session() as s:
        assert s.execute(text("SELECT name FROM organisations WHERE id=:i"), {"i": b["org_id"]}).scalar() == "Tenant B"
    # and B is untouched / reachable by its own owner
    assert (
        client.get(f"/v1/organisations/{b['org_id']}", headers=auth_headers(b["user_id"])).json()["name"] == "Tenant B"
    )


def test_role_checks(client, make_org):
    a = make_org()
    viewer, mgr = add_user(a["org_id"], "viewer"), add_user(a["org_id"], "bid_manager")
    url = f"/v1/organisations/{a['org_id']}"
    assert client.get(url, headers=auth_headers(viewer)).status_code == 200
    assert client.patch(url, json={"timezone": "Europe/Dublin"}, headers=auth_headers(viewer)).status_code == 403
    assert client.patch(url, json={"timezone": "Europe/Dublin"}, headers=auth_headers(mgr)).status_code == 403
    r = client.patch(url, json={"name": "Renamed Ltd"}, headers=auth_headers(a["user_id"]))
    assert r.status_code == 200 and r.json()["name"] == "Renamed Ltd"


def test_create_org_is_idempotent_and_makes_caller_owner(client, make_org):
    uid = make_org()["user_id"]
    key = {"Idempotency-Key": "create-org-0001", **auth_headers(uid)}
    r1 = client.post("/v1/organisations", json={"name": "Fresh Co"}, headers=key)
    r2 = client.post("/v1/organisations", json={"name": "Fresh Co"}, headers=key)
    assert r1.status_code == 201 and r2.status_code == 200 and r1.json()["id"] == r2.json()["id"]
    assert r2.headers["Idempotent-Replay"] == "true"
    me = client.get("/v1/me", headers=auth_headers(uid)).json()
    assert {m["organisation_id"]: m["role"] for m in me["memberships"]}[r1.json()["id"]] == "owner"
    assert client.post("/v1/organisations", json={"name": "Fresh Co"}, headers=auth_headers(uid)).status_code == 422


def test_last_owner_cannot_be_demoted_or_removed(client, make_org):
    a = make_org()
    base = f"/v1/organisations/{a['org_id']}/members/{a['user_id']}"
    assert (
        client.patch(base, json={"role": "viewer"}, headers=auth_headers(a["user_id"])).json()["error"]["code"]
        == "last_owner"
    )
    assert client.delete(base, headers=auth_headers(a["user_id"])).status_code == 409


def test_membership_changes_are_audited(client, make_org):
    a = make_org()
    other = add_user(a["org_id"], "viewer")
    r = client.patch(
        f"/v1/organisations/{a['org_id']}/members/{other}",
        json={"role": "reviewer"},
        headers=auth_headers(a["user_id"]),
    )
    assert r.status_code == 200
    with owner_session() as s:
        row = s.execute(
            text(
                "SELECT actor_type, before, after FROM audit_log WHERE action='membership.role_changed' AND organisation_id=:o"
            ),
            {"o": a["org_id"]},
        ).one()
    assert row[0] == "human" and row[1] == {"role": "viewer"} and row[2] == {"role": "reviewer"}


def test_dev_token_is_disabled_outside_dev(client):
    assert client.post("/v1/auth/dev-token", json={"login": "x"}).status_code == 404


def test_dev_token_works_in_dev(migrated_db, monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as c:
            tok = c.post("/v1/auth/dev-token", json={"login": "dev-user-1"}).json()
            assert (
                c.get("/v1/me", headers={"Authorization": f"Bearer {tok['access_token']}"}).json()["login"]
                == "dev-user-1"
            )
    finally:
        monkeypatch.setenv("ENV", "test")
        get_settings.cache_clear()


def test_rate_limit_per_organisation(client, make_org, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "3")
    get_settings.cache_clear()
    try:
        a, b = make_org(), make_org()
        codes = [
            client.get(f"/v1/organisations/{a['org_id']}", headers=auth_headers(a["user_id"])).status_code
            for _ in range(5)
        ]
        assert codes == [200, 200, 200, 429, 429]
        r = client.get(f"/v1/organisations/{a['org_id']}", headers=auth_headers(a["user_id"]))
        assert r.json()["error"]["code"] == "rate_limited" and "Retry-After" in r.headers
        assert client.get(f"/v1/organisations/{b['org_id']}", headers=auth_headers(b["user_id"])).status_code == 200
    finally:
        monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "100000")
        get_settings.cache_clear()
        ratelimit.reset()


def test_health_ready_metadata_and_openapi(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json() == {"status": "ready"}
    md = client.get("/v1/metadata").json()
    assert (
        "CC BY 4.0" in md["data_sources"]["etenders"]["licence"]
        and "ted.europa.eu" in md["data_sources"]["ted"]["source"]
    )
    spec = client.get("/openapi.json").json()
    assert "/v1/organisations" in spec["paths"] and "/v1/notices" in spec["paths"]


def test_add_member_is_idempotent(client, make_org):
    a = make_org()
    other = add_user(make_org()["org_id"], "viewer")
    with owner_session() as s:
        login = s.execute(text("SELECT login FROM users WHERE id=:i"), {"i": other}).scalar()
    url = f"/v1/organisations/{a['org_id']}/members"
    h = {"Idempotency-Key": "add-member-0001", **auth_headers(a["user_id"])}
    r1 = client.post(url, json={"login": login, "role": "reviewer"}, headers=h)
    r2 = client.post(url, json={"login": login, "role": "reviewer"}, headers=h)
    assert r1.status_code == 201 and r2.status_code == 201 and r2.headers["Idempotent-Replay"] == "true"
    h2 = {"Idempotency-Key": "add-member-0001", **auth_headers(a["user_id"])}
    assert client.post(url, json={"login": login, "role": "viewer"}, headers=h2).status_code == 422


def test_shared_notice_endpoints_are_rate_limited_per_user(client, make_org, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "2")
    get_settings.cache_clear()
    try:
        first, second = make_org()["user_id"], make_org()["user_id"]
        codes = [client.get("/v1/notices?limit=1", headers=auth_headers(first)).status_code for _ in range(3)]
        assert codes == [200, 200, 429]
        assert client.get("/v1/notices?limit=1", headers=auth_headers(second)).status_code == 200
    finally:
        monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "100000")
        get_settings.cache_clear()
        ratelimit.reset()


def test_rate_limiter_forgets_subjects_from_earlier_minutes(monkeypatch):
    import uuid as uuid_module

    ratelimit.reset()
    monkeypatch.setattr(ratelimit, "_PRUNE_ABOVE", 50)
    now = [1_000_000.0]
    monkeypatch.setattr(ratelimit.time, "time", lambda: now[0])
    for _ in range(40):
        ratelimit.check(uuid_module.uuid4())
    now[0] += 120  # two minutes later
    for _ in range(20):
        ratelimit.check(uuid_module.uuid4())
    assert ratelimit.tracked_subjects() <= 21
    ratelimit.reset()


def test_env_defaults_to_production_so_the_dev_token_is_off_unless_asked_for(monkeypatch):
    from tenderline.config import Settings

    monkeypatch.delenv("ENV", raising=False)
    assert Settings(_env_file=None).env == "prod" and not Settings(_env_file=None).is_dev
