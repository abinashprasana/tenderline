from __future__ import annotations

import re
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select

from tenderline.api.deps import CanRead, CanWrite, Ctx, IdemKey, idempotent
from tenderline.audit import write_audit
from tenderline.errors import not_found
from tenderline.models import Match, Notice, SavedSearch
from tenderline.pagination import paginate
from tenderline.workflows import runtime

router = APIRouter(prefix="/v1/organisations/{org_id}", tags=["searches", "matches"])


class SearchIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    cpv_codes: list[str] = Field(default_factory=list, max_length=100)
    buyer_names: list[str] = Field(default_factory=list, max_length=100)
    keywords: list[str] = Field(default_factory=list, max_length=100)
    countries: list[str] = Field(default_factory=list, max_length=40)
    min_value: Decimal | None = Field(default=None, ge=0)
    max_value: Decimal | None = Field(default=None, ge=0)
    active: bool = True

    @field_validator("cpv_codes")
    @classmethod
    def _cpv(cls, v: list[str]) -> list[str]:
        for c in v:
            if not re.fullmatch(r"\d{2,8}", c):
                raise ValueError(f"invalid CPV code {c!r} (2-8 digits)")
        return v

    @field_validator("countries")
    @classmethod
    def _countries(cls, v: list[str]) -> list[str]:
        out = [c.upper() for c in v]
        for c in out:
            if not re.fullmatch(r"[A-Z]{3}", c):
                raise ValueError(f"invalid country {c!r}: use ISO 3166-1 alpha-3, e.g. IRL")
        return out

    @field_validator("keywords", "buyer_names")
    @classmethod
    def _strip(cls, v: list[str]) -> list[str]:
        return [x.strip() for x in v if x.strip()]

    @model_validator(mode="after")
    def _check(self) -> SearchIn:
        if not (
            self.cpv_codes or self.buyer_names or self.keywords or self.countries or self.min_value or self.max_value
        ):
            raise ValueError("a saved search needs at least one criterion")
        if self.min_value is not None and self.max_value is not None and self.min_value > self.max_value:
            raise ValueError("min_value must not exceed max_value")
        return self


class SearchPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    active: bool | None = None


class SearchOut(SearchIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    created_at: datetime


class SearchPage(BaseModel):
    items: list[SearchOut]
    next_cursor: str | None


class MatchOut(BaseModel):
    id: uuid.UUID
    saved_search_id: uuid.UUID
    notice_id: uuid.UUID
    notice_version: int
    notice_title: str
    notice_deadline_at: datetime | None
    reasons: dict[str, Any]
    qualified_at: datetime | None
    created_at: datetime


class MatchPage(BaseModel):
    items: list[MatchOut]
    next_cursor: str | None


def _snap(s: SavedSearch) -> dict[str, Any]:
    return {
        "name": s.name,
        "cpv_codes": s.cpv_codes,
        "buyer_names": s.buyer_names,
        "keywords": s.keywords,
        "countries": s.countries,
        "min_value": str(s.min_value) if s.min_value is not None else None,
        "max_value": str(s.max_value) if s.max_value is not None else None,
        "active": s.active,
    }


@router.post("/saved-searches", status_code=201, response_model=SearchOut)
def create_search(
    org_id: uuid.UUID, payload: SearchIn, ctx: CanWrite, key: IdemKey, bg: BackgroundTasks
) -> JSONResponse:
    def run() -> tuple[int, Any]:
        s = SavedSearch(organisation_id=org_id, **payload.model_dump())
        ctx.db.add(s)
        ctx.db.flush()
        ctx.db.refresh(s)
        write_audit(
            ctx.db,
            org_id,
            actor_type="human",
            actor_id=str(ctx.user_id),
            action="saved_search.created",
            entity_type="saved_search",
            entity_id=s.id,
            after=_snap(s),
        )
        bg.add_task(runtime.enqueue_backfill, org_id, s.id)  # after commit: match existing open notices
        return 201, SearchOut.model_validate(s)

    return idempotent(ctx.db, org_id, key, payload, run)


@router.get("/saved-searches", response_model=SearchPage)
def list_searches(org_id: uuid.UUID, ctx: CanRead, cursor: str | None = None, limit: int = 50) -> SearchPage:
    rows, nxt = paginate(ctx.db, select(SavedSearch), SavedSearch.created_at, SavedSearch.id, cursor, limit)
    return SearchPage(items=[SearchOut.model_validate(r) for r in rows], next_cursor=nxt)


def _get_search(ctx: Ctx, search_id: uuid.UUID) -> SavedSearch:
    s = ctx.db.get(SavedSearch, search_id)
    if s is None:
        raise not_found("Saved search")
    return s


@router.get("/saved-searches/{search_id}", response_model=SearchOut)
def get_search(org_id: uuid.UUID, search_id: uuid.UUID, ctx: CanRead) -> SavedSearch:
    return _get_search(ctx, search_id)


@router.put("/saved-searches/{search_id}", response_model=SearchOut, summary="Replace a saved search")
def replace_search(
    org_id: uuid.UUID, search_id: uuid.UUID, payload: SearchIn, ctx: CanWrite, bg: BackgroundTasks
) -> SavedSearch:
    s = _get_search(ctx, search_id)
    before = _snap(s)
    for k, v in payload.model_dump().items():
        setattr(s, k, v)
    ctx.db.flush()
    write_audit(
        ctx.db,
        org_id,
        actor_type="human",
        actor_id=str(ctx.user_id),
        action="saved_search.updated",
        entity_type="saved_search",
        entity_id=s.id,
        before=before,
        after=_snap(s),
    )
    return s


@router.patch("/saved-searches/{search_id}", response_model=SearchOut, summary="Rename or (de)activate")
def patch_search(
    org_id: uuid.UUID, search_id: uuid.UUID, payload: SearchPatch, ctx: CanWrite, bg: BackgroundTasks
) -> SavedSearch:
    s = _get_search(ctx, search_id)
    before = _snap(s)
    if payload.name is not None:
        s.name = payload.name
    if payload.active is not None:
        s.active = payload.active
    ctx.db.flush()
    write_audit(
        ctx.db,
        org_id,
        actor_type="human",
        actor_id=str(ctx.user_id),
        action="saved_search.updated",
        entity_type="saved_search",
        entity_id=s.id,
        before=before,
        after=_snap(s),
    )
    return s


@router.delete("/saved-searches/{search_id}", status_code=204)
def delete_search(org_id: uuid.UUID, search_id: uuid.UUID, ctx: CanWrite) -> None:
    s = _get_search(ctx, search_id)
    if ctx.db.scalars(select(Match.id).where(Match.saved_search_id == s.id)).first():
        # keep matches (and their audit trail) intact: deactivate instead of deleting
        s.active = False
    else:
        ctx.db.delete(s)
    write_audit(
        ctx.db,
        org_id,
        actor_type="human",
        actor_id=str(ctx.user_id),
        action="saved_search.deleted",
        entity_type="saved_search",
        entity_id=search_id,
        before=_snap(s),
    )


@router.get("/matches", response_model=MatchPage, summary="List matches (newest first)")
def list_matches(
    org_id: uuid.UUID,
    ctx: CanRead,
    saved_search_id: uuid.UUID | None = None,
    notice_id: uuid.UUID | None = None,
    qualified: bool | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> MatchPage:
    stmt = select(Match)
    if saved_search_id:
        stmt = stmt.where(Match.saved_search_id == saved_search_id)
    if notice_id:
        stmt = stmt.where(Match.notice_id == notice_id)
    if qualified is not None:
        stmt = stmt.where(Match.qualified_at.is_not(None) if qualified else Match.qualified_at.is_(None))
    rows, nxt = paginate(ctx.db, stmt, Match.created_at, Match.id, cursor, limit)
    return MatchPage(items=_match_out(ctx, rows), next_cursor=nxt)


def _match_out(ctx: Ctx, rows: list[Match]) -> list[MatchOut]:
    notices = {n.id: n for n in ctx.db.scalars(select(Notice).where(Notice.id.in_([m.notice_id for m in rows])))}
    return [
        MatchOut(
            id=m.id,
            saved_search_id=m.saved_search_id,
            notice_id=m.notice_id,
            notice_version=m.notice_version,
            notice_title=notices[m.notice_id].title,
            notice_deadline_at=notices[m.notice_id].deadline_at,
            reasons=m.reasons,
            qualified_at=m.qualified_at,
            created_at=m.created_at,
        )
        for m in rows
    ]


@router.get("/matches/{match_id}", response_model=MatchOut)
def get_match(org_id: uuid.UUID, match_id: uuid.UUID, ctx: CanRead) -> MatchOut:
    m = ctx.db.get(Match, match_id)
    if m is None:
        raise not_found("Match")
    return _match_out(ctx, [m])[0]


@router.post(
    "/matches/{match_id}/qualify",
    status_code=202,
    summary="Ask the agent to (re)qualify a match",
    description="Enqueues qualification on the queue. The agent only writes proposals; a human approves them.",
)
def requalify(org_id: uuid.UUID, match_id: uuid.UUID, ctx: CanWrite, key: IdemKey) -> JSONResponse:
    if ctx.db.get(Match, match_id) is None:
        raise not_found("Match")

    def run() -> tuple[int, Any]:
        wid = runtime.enqueue_qualify(org_id, match_id, key)
        write_audit(
            ctx.db,
            org_id,
            actor_type="human",
            actor_id=str(ctx.user_id),
            action="match.qualify_requested",
            entity_type="match",
            entity_id=match_id,
            after={"workflow_id": wid},
        )
        return 202, {"workflow_id": wid, "match_id": str(match_id), "status": "enqueued"}

    return idempotent(ctx.db, org_id, key, {"match": str(match_id)}, run)
