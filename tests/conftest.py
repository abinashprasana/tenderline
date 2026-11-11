"""Test harness. Integration tests need a real Postgres (compose `db` service or a CI service)."""

from __future__ import annotations

import os
import uuid

import pytest

_PORT = os.environ.get("TEST_DB_PORT", "5433")
_HOST = os.environ.get("TEST_DB_HOST", "localhost")
_DB = "tenderline_test"
_SUPER = os.environ.get("TEST_DB_SUPERUSER_URL", f"postgresql://tenderline:tenderline@{_HOST}:{_PORT}/postgres")

os.environ.update(
    ENV="test",
    DATABASE_URL=f"postgresql+psycopg://tenderline:tenderline@{_HOST}:{_PORT}/{_DB}",
    APP_DATABASE_URL=f"postgresql+psycopg://tenderline_app:tenderline_app@{_HOST}:{_PORT}/{_DB}",
    DBOS_SYSTEM_DATABASE_URL=f"postgresql://tenderline:tenderline@{_HOST}:{_PORT}/{_DB}_dbos",
    JWT_SECRET="test-secret-test-secret-test-secret!",
    LLM_PROVIDER_CHAIN="fake",
    OTEL_ENABLED="false",
    RATE_LIMIT_PER_MINUTE="100000",
)


@pytest.fixture(scope="session")
def migrated_db() -> str:
    import psycopg
    from alembic import command
    from alembic.config import Config

    with psycopg.connect(_SUPER, autocommit=True) as conn:
        for name in (_DB, f"{_DB}_dbos"):
            conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            conn.execute(f'CREATE DATABASE "{name}" OWNER tenderline')
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "head")
    return _DB


@pytest.fixture()
def owner(migrated_db):
    from tenderline.db import owner_session

    return owner_session


@pytest.fixture()
def make_org(migrated_db):
    """Create an organisation (+ owner user) as the table owner; returns ids."""
    from sqlalchemy import text

    from tenderline.db import owner_session

    def _make(name: str = "Acme Ltd", role: str = "owner") -> dict:
        org_id, user_id = uuid.uuid4(), uuid.uuid4()
        with owner_session() as s:
            s.execute(
                text("INSERT INTO organisations (id, name, slug) VALUES (:i, :n, :s)"),
                {"i": org_id, "n": name, "s": f"{name.lower().replace(' ', '-')}-{org_id.hex[:6]}"},
            )
            s.execute(
                text("INSERT INTO users (id, login, github_id) VALUES (:i, :l, :g)"),
                {"i": user_id, "l": f"user-{user_id.hex[:6]}", "g": int(user_id.int % 10**9)},
            )
            s.execute(
                text("INSERT INTO memberships (organisation_id, user_id, role) VALUES (:o, :u, :r)"),
                {"o": org_id, "u": user_id, "r": role},
            )
        return {"org_id": org_id, "user_id": user_id}

    return _make
