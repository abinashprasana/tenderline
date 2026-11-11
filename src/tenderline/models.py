"""SQLAlchemy models. The authoritative DDL (RLS, triggers, grants) lives in the Alembic migrations."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))


def _ts() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _org_fk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), ForeignKey("organisations.id"), nullable=False, index=True)


# ---------------------------------------------------------------- identity / tenancy
class Organisation(Base):
    __tablename__ = "organisations"
    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    profile: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    timezone: Mapped[str | None] = mapped_column(String(64), server_default="Europe/Dublin")
    created_at: Mapped[datetime] = _ts()


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _uuid_pk()
    github_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    login: Mapped[str] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(320))
    name: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = _ts()


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("organisation_id", "user_id"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # owner | bid_manager | reviewer | viewer
    created_at: Mapped[datetime] = _ts()


# ---------------------------------------------------------------- shared public procurement data
class Buyer(Base):
    __tablename__ = "buyers"
    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(400))
    normalised_name: Mapped[str] = mapped_column(String(400))
    country: Mapped[str | None] = mapped_column(String(3))
    __table_args__ = (UniqueConstraint("normalised_name", "country"),)


class CpvCode(Base):
    __tablename__ = "cpv_codes"
    code: Mapped[str] = mapped_column(String(8), primary_key=True)
    division: Mapped[str] = mapped_column(String(2), index=True)
    description: Mapped[str | None] = mapped_column(String(300))


class Notice(Base):
    __tablename__ = "notices"
    __table_args__ = (UniqueConstraint("source", "source_id"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    source: Mapped[str] = mapped_column(String(20))  # ted | etenders
    source_id: Mapped[str] = mapped_column(String(100))
    source_url: Mapped[str | None] = mapped_column(Text)
    notice_type: Mapped[str] = mapped_column(String(50))
    procedure_id: Mapped[str | None] = mapped_column(String(100), index=True)
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(500))
    summary: Mapped[str | None] = mapped_column(String(600))  # short summary only, never full buyer text
    buyer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("buyers.id"), index=True)
    country: Mapped[str | None] = mapped_column(String(3), index=True)
    publication_date: Mapped[date | None] = mapped_column(Date, index=True)
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    estimated_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    currency: Mapped[str | None] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | awarded
    award: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class NoticeVersion(Base):
    __tablename__ = "notice_versions"
    __table_args__ = (UniqueConstraint("notice_id", "version"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    notice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notices.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB)  # raw payload kept verbatim for replay
    fields: Mapped[dict[str, Any]] = mapped_column(JSONB)  # normalised structured snapshot
    changes: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # diff vs previous version
    fetched_at: Mapped[datetime] = _ts()


class Lot(Base):
    __tablename__ = "lots"
    __table_args__ = (UniqueConstraint("notice_id", "version", "position"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    notice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notices.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)
    estimated_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class NoticeCpv(Base):
    __tablename__ = "notice_cpv"
    notice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notices.id"), primary_key=True)
    cpv_code: Mapped[str] = mapped_column(ForeignKey("cpv_codes.code"), primary_key=True)
    is_main: Mapped[bool] = mapped_column(Boolean, default=False)


class IngestionRun(Base):
    __tablename__ = "ingestion_runs"
    id: Mapped[uuid.UUID] = _uuid_pk()
    source: Mapped[str] = mapped_column(String(20))
    window_from: Mapped[date | None] = mapped_column(Date)
    started_at: Mapped[datetime] = _ts()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | ok | error
    cursor: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # {"token":..., "page":..., "query":...}
    notices_seen: Mapped[int] = mapped_column(Integer, default=0)
    notices_new: Mapped[int] = mapped_column(Integer, default=0)
    notices_updated: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    workflow_id: Mapped[str | None] = mapped_column(String(200))


# ---------------------------------------------------------------- tenant-owned (RLS)
class SavedSearch(Base):
    __tablename__ = "saved_searches"
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    name: Mapped[str] = mapped_column(String(200))
    cpv_codes: Mapped[list[str]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    buyer_names: Mapped[list[str]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    keywords: Mapped[list[str]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    countries: Mapped[list[str]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    min_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    max_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = _ts()


class Match(Base):
    __tablename__ = "matches"
    __table_args__ = (UniqueConstraint("organisation_id", "saved_search_id", "notice_id"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    saved_search_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("saved_searches.id"))
    notice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notices.id"), index=True)
    notice_version: Mapped[int] = mapped_column(Integer)
    reasons: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    qualified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()


class Opportunity(Base):
    __tablename__ = "opportunities"
    __table_args__ = (UniqueConstraint("organisation_id", "notice_id"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    notice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notices.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="new")  # new|bid|no_bid|submitted|won|lost
    outcome: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    assigned_reviewer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    flags: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    workflow_id: Mapped[str | None] = mapped_column(String(200))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()


class Deadline(Base):
    __tablename__ = "deadlines"
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    opportunity_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("opportunities.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))  # submission | reminder | clarification | custom
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(String(500))
    source: Mapped[str] = mapped_column(String(20), default="human")  # human | notice | agent
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()


class AgentProposal(Base):
    __tablename__ = "agent_proposals"
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    match_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("matches.id"), index=True)
    notice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notices.id"), index=True)
    notice_version: Mapped[int] = mapped_column(Integer)
    action_type: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    rationale: Mapped[str | None] = mapped_column(Text)
    fit_score: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    # pending | approved | rejected | cancelled | executed | failed
    llm_call_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _ts()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Approval(Base):
    __tablename__ = "approvals"
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    proposal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agent_proposals.id"), unique=True)
    decision: Mapped[str] = mapped_column(String(20))  # approved | edited | rejected
    decided_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    edited_payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    occurred_at: Mapped[datetime] = _ts()
    actor_type: Mapped[str] = mapped_column(String(10))  # human | agent
    actor_id: Mapped[str] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(80), index=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(100), index=True)
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    trace_id: Mapped[str | None] = mapped_column(String(32))


class LlmCall(Base):
    __tablename__ = "llm_calls"
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    notice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notices.id"))
    notice_version: Mapped[int] = mapped_column(Integer)
    cache_key: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(30))
    model: Mapped[str] = mapped_column(String(100))
    prompt_version: Mapped[str] = mapped_column(String(40))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=0)
    status: Mapped[str] = mapped_column(String(20), default="ok")  # ok | invalid | error
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    trace_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = _ts()


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"
    __table_args__ = (UniqueConstraint("organisation_id", "key"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    organisation_id: Mapped[uuid.UUID] = _org_fk()
    key: Mapped[str] = mapped_column(String(200))
    request_hash: Mapped[str] = mapped_column(String(64))
    status_code: Mapped[int | None] = mapped_column(Integer)
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _ts()


TENANT_TABLES = [
    "memberships",
    "saved_searches",
    "matches",
    "opportunities",
    "deadlines",
    "agent_proposals",
    "approvals",
    "audit_log",
    "llm_calls",
    "idempotency_keys",
]
