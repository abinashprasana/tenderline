"""render/entrypoint.py turns Render's variables into the ones Tenderline reads."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

SPEC = importlib.util.spec_from_file_location(
    "render_entrypoint", Path(__file__).resolve().parents[2] / "render" / "entrypoint.py"
)
assert SPEC and SPEC.loader
entry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entry)

RENDER = {
    "DATABASE_URL": "postgresql://tl_user:s3cret@dpg-abc123-a/tenderline_x9",
    "APP_DB_PASSWORD": "pw+/=with&odd:chars",
    "RENDER_GIT_COMMIT": "0123456789abcdef0123456789abcdef01234567",
    "RENDER_EXTERNAL_URL": "https://tenderline-ab12.onrender.com/",
}


def test_owner_url_gets_the_psycopg_driver() -> None:
    out = entry.derive(RENDER)
    assert out["DATABASE_URL"].startswith("postgresql+psycopg://tl_user:s3cret@dpg-abc123-a/tenderline_x9")


def test_old_style_postgres_scheme_is_accepted() -> None:
    out = entry.derive({**RENDER, "DATABASE_URL": "postgres://u:p@h/db"})
    assert make_url(out["DATABASE_URL"]).drivername == "postgresql+psycopg"


def test_app_role_url_uses_the_app_password_even_with_odd_characters() -> None:
    url = make_url(entry.derive(RENDER)["APP_DATABASE_URL"])
    assert (url.username, url.password) == ("tenderline_app", "pw+/=with&odd:chars")
    assert (url.host, url.database) == ("dpg-abc123-a", "tenderline_x9")


def test_dbos_shares_the_application_database() -> None:
    url = make_url(entry.derive(RENDER)["DBOS_SYSTEM_DATABASE_URL"])
    assert url.drivername == "postgresql"
    assert (url.username, url.password, url.host, url.database) == (
        "tl_user",
        "s3cret",
        "dpg-abc123-a",
        "tenderline_x9",
    )


def test_provider_query_options_are_kept() -> None:
    out = entry.derive({**RENDER, "DATABASE_URL": "postgresql://u:p@ep-1.neon.tech/db?sslmode=require"})
    for key in ("DATABASE_URL", "APP_DATABASE_URL", "DBOS_SYSTEM_DATABASE_URL"):
        assert make_url(out[key]).query == {"sslmode": "require"}


def test_version_and_redirect_come_from_render() -> None:
    out = entry.derive(RENDER)
    assert out["APP_VERSION"] == "0123456789ab"
    assert out["GITHUB_REDIRECT_URI"] == "https://tenderline-ab12.onrender.com/auth/callback"
    assert out["WEB_CONCURRENCY"] == "1"


def test_nothing_set_by_hand_is_overridden() -> None:
    env = {
        **RENDER,
        "APP_DATABASE_URL": "x",
        "DBOS_SYSTEM_DATABASE_URL": "y",
        "APP_VERSION": "v7",
        "GITHUB_REDIRECT_URI": "https://example.test/auth/callback",
        "WEB_CONCURRENCY": "2",
    }
    out = entry.derive(env)
    assert set(out) == {"DATABASE_URL"}


def test_outside_render_nothing_extra_is_invented() -> None:
    out = entry.derive({"DATABASE_URL": "postgresql://u:p@h/db", "APP_DB_PASSWORD": "pw"})
    assert "APP_VERSION" not in out
    assert "GITHUB_REDIRECT_URI" not in out


@pytest.mark.parametrize("env", [{}, {"DATABASE_URL": "postgresql://u:p@h/db"}])
def test_missing_settings_stop_with_a_clear_message(env: dict[str, str]) -> None:
    with pytest.raises(SystemExit, match="is not set"):
        entry.derive(env)
