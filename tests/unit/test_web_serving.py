"""The opt-in static serving mirrors frontend/caddy/tenderline.caddy and is off unless SERVE_WEB_DIR is set."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tenderline.api.webapp import CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY, is_api_path, mount_web

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture()
def web(tmp_path: Path) -> TestClient:
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app-abc123.js").write_text("console.log(1)" * 100)
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "wren.gltf").write_text("{}")
    (tmp_path / "index.html").write_text("<!doctype html><title>Tenderline</title>")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    (tmp_path.parent / "secret.txt").write_text("outside the web directory")

    app = FastAPI()

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/ping")
    def ping() -> dict[str, str]:
        return {"pong": "yes"}

    mount_web(app, str(tmp_path))
    return TestClient(app)


def test_api_routes_win(web: TestClient) -> None:
    assert web.get("/healthz").json() == {"status": "ok"}
    assert web.get("/v1/ping").json() == {"pong": "yes"}


@pytest.mark.parametrize("path", ["/v1/nope", "/v1/", "/docs/nothing-here", "/v1/a/b/c"])
def test_unclaimed_api_paths_are_404_not_the_app(web: TestClient, path: str) -> None:
    response = web.get(path)
    assert response.status_code == 404
    assert "<title>" not in response.text


@pytest.mark.parametrize("path", ["/docs", "/openapi.json", "/redoc"])
def test_built_in_docs_stay_with_the_api(web: TestClient, path: str) -> None:
    response = web.get(path)
    assert response.status_code == 200
    assert "<title>Tenderline</title>" not in response.text


@pytest.mark.parametrize("path", ["/", "/auth/callback", "/o/123/approvals", "/v1", "/healthz/x", "/anything/at/all"])
def test_everything_else_is_the_single_page_app(web: TestClient, path: str) -> None:
    response = web.get(path)
    assert response.status_code == 200
    assert "<title>Tenderline</title>" in response.text
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["content-security-policy"] == CONTENT_SECURITY_POLICY
    assert response.headers["permissions-policy"] == PERMISSIONS_POLICY


def test_real_files_are_served_as_themselves(web: TestClient) -> None:
    assert web.get("/favicon.svg").text == "<svg/>"
    assert web.get("/models/wren.gltf").headers["content-type"].startswith("model/gltf+json")


def test_hashed_assets_are_immutable_and_missing_ones_are_404(web: TestClient) -> None:
    ok = web.get("/assets/app-abc123.js")
    assert ok.status_code == 200
    assert ok.headers["cache-control"] == "public, max-age=31536000, immutable"
    missing = web.get("/assets/gone.js")
    assert missing.status_code == 404
    assert "<title>" not in missing.text


@pytest.mark.parametrize(
    "path", ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt"]
)
def test_cannot_read_outside_the_web_directory(web: TestClient, path: str) -> None:
    assert "outside the web directory" not in web.get(path).text


def test_baseline_headers_everywhere_and_head_works(web: TestClient) -> None:
    for path in ("/v1/ping", "/", "/assets/app-abc123.js"):
        headers = web.get(path).headers
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["x-frame-options"] == "DENY"
        assert headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert web.head("/auth/callback").status_code == 200


def test_big_responses_are_compressed(web: TestClient) -> None:
    response = web.get("/assets/app-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert response.headers.get("content-encoding") == "gzip"


def test_refuses_a_directory_without_a_build(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="index.html"):
        mount_web(FastAPI(), str(tmp_path))


def test_routing_table_matches_caddy() -> None:
    """Same API paths as the Caddy snippet, so the two deployments cannot drift apart."""
    caddy = (REPO / "frontend" / "caddy" / "tenderline.caddy").read_text(encoding="utf-8")
    matcher = re.search(r"@api path (.+)", caddy)
    assert matcher
    for pattern in matcher.group(1).split():
        sample = pattern.replace("*", "x")
        assert is_api_path(sample), pattern
    assert not is_api_path("/v1")
    assert not is_api_path("/auth/callback")
    csp = re.search(r'Content-Security-Policy "([^"]+)"', caddy)
    assert csp
    assert csp.group(1) == CONTENT_SECURITY_POLICY
    assert re.search(r'Permissions-Policy "([^"]+)"', caddy).group(1) == PERMISSIONS_POLICY  # type: ignore[union-attr]


def test_off_by_default() -> None:
    from tenderline.api.app import create_app
    from tenderline.config import get_settings

    assert get_settings().serve_web_dir == ""
    paths = {getattr(route, "path", "") for route in create_app().routes}
    assert "/{path:path}" not in paths
