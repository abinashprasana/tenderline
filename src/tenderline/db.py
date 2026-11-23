"""Database engines and tenant-scoped sessions.

The app connects as a non-superuser role subject to row-level security. Every tenant-owned query runs
inside a transaction where `app.org_id` has been set with `set_config(..., true)` (transaction-local), so
a pooled connection can never leak one tenant's context into the next request.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from tenderline.config import get_settings


@lru_cache
def get_engine() -> Engine:
    s = get_settings()
    return create_engine(
        s.app_database_url, pool_size=s.db_pool_size, max_overflow=s.db_max_overflow, pool_pre_ping=True
    )


@lru_cache
def get_owner_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


def reset_engines() -> None:
    get_engine.cache_clear()
    get_owner_engine.cache_clear()


def _factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


@contextmanager
def tenant_session(org_id: uuid.UUID | str) -> Iterator[Session]:
    """Session whose transaction is scoped to one organisation. Commits on success."""
    with _factory()() as session, session.begin():
        session.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": str(org_id)})
        yield session


@contextmanager
def public_session() -> Iterator[Session]:
    """Session for shared (non-tenant) tables: notices, buyers, cpv, ingestion runs, users."""
    with _factory()() as session, session.begin():
        yield session


@contextmanager
def owner_session() -> Iterator[Session]:
    """Table-owner session. Only used by migrations, tests and the seed tool."""
    with sessionmaker(bind=get_owner_engine(), expire_on_commit=False)() as session, session.begin():
        yield session


def list_org_ids() -> list[uuid.UUID]:
    """Cross-tenant organisation listing via a SECURITY DEFINER function (ids only)."""
    with public_session() as s:
        return [r[0] for r in s.execute(text("SELECT org_id FROM app_list_org_ids()"))]
