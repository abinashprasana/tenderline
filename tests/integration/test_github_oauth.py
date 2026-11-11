"""GitHub OAuth login, with the GitHub HTTP calls replaced by a fake client (no network)."""

import pytest
from fastapi.testclient import TestClient

from tenderline.api.app import create_app
from tenderline.api.routers import auth as auth_router
from tenderline.config import get_settings


class FakeResponse:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class FakeGithub:
    """Stands in for httpx.Client inside the auth router."""

    token_ok = True
    profile = {"id": 424242, "login": "octo-bidder", "email": "octo@example.invalid", "name": "Octo Bidder"}
    calls: list = []

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, json=None, headers=None):
        FakeGithub.calls.append(("POST", url, json))
        return FakeResponse({"access_token": "gho_fake"} if FakeGithub.token_ok else {"error": "bad_verification_code"})

    def get(self, url, headers=None):
        FakeGithub.calls.append(("GET", url, headers))
        return FakeResponse(FakeGithub.profile)


@pytest.fixture()
def configured(migrated_db, monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "client-123")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "secret-456")
    get_settings.cache_clear()
    FakeGithub.token_ok, FakeGithub.calls = True, []
    monkeypatch.setattr(auth_router.httpx, "Client", FakeGithub)
    with TestClient(create_app()) as c:
        yield c
    monkeypatch.delenv("GITHUB_CLIENT_ID")
    monkeypatch.delenv("GITHUB_CLIENT_SECRET")
    get_settings.cache_clear()


def test_login_is_503_with_a_clear_error_when_not_configured(migrated_db):
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        r = c.get("/v1/auth/github/login")
    assert r.status_code == 503 and r.json()["error"]["code"] == "github_oauth_not_configured"


def test_login_returns_an_authorize_url_with_a_signed_state(configured):
    url = configured.get("/v1/auth/github/login").json()["authorize_url"]
    assert url.startswith("https://github.com/login/oauth/authorize?") and "client_id=client-123" in url
    assert "state=" in url and "read%3Auser" in url


def test_callback_issues_a_jwt_and_upserts_the_user(configured):
    state = configured.get("/v1/auth/github/login").json()["authorize_url"].split("state=")[1].split("&")[0]
    r = configured.get(f"/v1/auth/github/callback?code=abc&state={state}")
    assert r.status_code == 200 and r.json()["login"] == "octo-bidder"
    token = r.json()["access_token"]
    me = configured.get("/v1/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["login"] == "octo-bidder" and me["id"] == r.json()["user_id"]
    # the code exchange used our client credentials
    post = next(c for c in FakeGithub.calls if c[0] == "POST")
    assert post[2]["client_id"] == "client-123" and post[2]["code"] == "abc"
    # logging in again with a changed GitHub login updates the same user (matched by GitHub id)
    FakeGithub.profile = {**FakeGithub.profile, "login": "octo-renamed"}
    try:
        fresh_state = configured.get("/v1/auth/github/login").json()["authorize_url"].split("state=")[1].split("&")[0]
        again = configured.get(f"/v1/auth/github/callback?code=def&state={fresh_state}").json()
    finally:
        FakeGithub.profile = {**FakeGithub.profile, "login": "octo-bidder"}
    assert again["user_id"] == r.json()["user_id"] and again["login"] == "octo-renamed"


def test_callback_rejects_a_forged_or_missing_state(configured):
    r = configured.get("/v1/auth/github/callback?code=abc&state=forged")
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_state"
    assert configured.get("/v1/auth/github/callback?code=abc").status_code == 422


def test_callback_reports_a_rejected_code(configured):
    state = configured.get("/v1/auth/github/login").json()["authorize_url"].split("state=")[1].split("&")[0]
    FakeGithub.token_ok = False
    r = configured.get(f"/v1/auth/github/callback?code=bad&state={state}")
    assert r.status_code == 400 and r.json()["error"]["code"] == "oauth_exchange_failed"


def test_callback_from_a_browser_that_did_not_start_the_login_is_refused(configured):
    state = configured.get("/v1/auth/github/login").json()["authorize_url"].split("state=")[1].split("&")[0]
    configured.cookies.clear()  # a different browser (the victim's) completes the attacker's login
    r = configured.get(f"/v1/auth/github/callback?code=abc&state={state}")
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_state"


def test_callback_handles_a_github_error_body_instead_of_crashing(configured):
    state = configured.get("/v1/auth/github/login").json()["authorize_url"].split("state=")[1].split("&")[0]
    FakeGithub.profile = {"message": "API rate limit exceeded"}
    try:
        r = configured.get(f"/v1/auth/github/callback?code=abc&state={state}")
    finally:
        FakeGithub.profile = {
            "id": 424242,
            "login": "octo-bidder",
            "email": "octo@example.invalid",
            "name": "Octo Bidder",
        }
    assert r.status_code == 502 and r.json()["error"]["code"] == "github_profile_unavailable"
