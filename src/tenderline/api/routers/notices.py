from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, exists, select
from sqlalchemy.orm import Session

from tenderline.api.deps import UserId
from tenderline.db import public_session
from tenderline.errors import not_found
from tenderline.models import Buyer, Notice, NoticeCpv, NoticeVersion
from tenderline.pagination import paginate

router = APIRouter(prefix="/v1/notices", tags=["notices"])


class NoticeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    source: str
    source_id: str
    source_url: str | None
    notice_type: str
    procedure_id: str | None
    current_version: int
    title: str
    summary: str | None
    buyer_id: uuid.UUID | None
    buyer_name: str | None = None
    country: str | None
    publication_date: date | None
    deadline_at: datetime | None
    estimated_value: Decimal | None
    currency: str | None
    status: str
    award: dict[str, Any] | None
    cpv_codes: list[str] = []


class NoticePage(BaseModel):
    items: list[NoticeOut]
    next_cursor: str | None


class VersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    version: int
    content_hash: str
    fetched_at: datetime
    fields: dict[str, Any]
    changes: dict[str, Any] | None


class NoticeFilters(BaseModel):
    q: str | None = None
    cpv: str | None = None
    buyer: str | None = None
    country: str | None = None
    source: str | None = None
    status: str | None = None
    notice_type: str | None = None
    published_from: date | None = None
    published_to: date | None = None
    min_value: Decimal | None = None
    max_value: Decimal | None = None
    deadline_after: datetime | None = None


def _filters(
    q: str | None = None,
    cpv: Annotated[str | None, Query(description="CPV code or prefix, e.g. 72 or 72200000")] = None,
    buyer: str | None = None,
    country: str | None = None,
    source: str | None = None,
    status: str | None = None,
    notice_type: str | None = None,
    published_from: date | None = None,
    published_to: date | None = None,
    min_value: Decimal | None = None,
    max_value: Decimal | None = None,
    deadline_after: datetime | None = None,
) -> NoticeFilters:
    return NoticeFilters(
        q=q,
        cpv=cpv,
        buyer=buyer,
        country=country,
        source=source,
        status=status,
        notice_type=notice_type,
        published_from=published_from,
        published_to=published_to,
        min_value=min_value,
        max_value=max_value,
        deadline_after=deadline_after,
    )


def apply_filters(stmt: Select[Any], f: NoticeFilters) -> Select[Any]:
    if f.q:
        stmt = stmt.where(Notice.title.ilike(f"%{f.q}%"))
    if f.cpv:
        stmt = stmt.where(
            exists().where(NoticeCpv.notice_id == Notice.id, NoticeCpv.cpv_code.like(f"{f.cpv}%"))
        )
    if f.buyer:
        stmt = stmt.where(Notice.buyer_id.in_(select(Buyer.id).where(Buyer.name.ilike(f"%{f.buyer}%"))))
    if f.country:
        stmt = stmt.where(Notice.country == f.country.upper())
    if f.source:
        stmt = stmt.where(Notice.source == f.source)
    if f.status:
        stmt = stmt.where(Notice.status == f.status)
    if f.notice_type:
        stmt = stmt.where(Notice.notice_type == f.notice_type)
    if f.published_from:
        stmt = stmt.where(Notice.publication_date >= f.published_from)
    if f.published_to:
        stmt = stmt.where(Notice.publication_date <= f.published_to)
    if f.min_value is not None:
        stmt = stmt.where(Notice.estimated_value >= f.min_value)
    if f.max_value is not None:
        stmt = stmt.where(Notice.estimated_value <= f.max_value)
    if f.deadline_after:
        stmt = stmt.where(Notice.deadline_at >= f.deadline_after)
    return stmt


def to_out(db: Session, notices: list[Notice]) -> list[NoticeOut]:
    ids = [n.id for n in notices]
    cpvs: dict[uuid.UUID, list[str]] = {i: [] for i in ids}
    for nid, code in db.execute(
        select(NoticeCpv.notice_id, NoticeCpv.cpv_code)
        .where(NoticeCpv.notice_id.in_(ids))
        .order_by(NoticeCpv.cpv_code)
    ):
        cpvs[nid].append(code)
    buyers = {
        b.id: b.name
        for b in db.scalars(select(Buyer).where(Buyer.id.in_([n.buyer_id for n in notices if n.buyer_id])))
    }
    out = []
    for n in notices:
        o = NoticeOut.model_validate(n)
        o.cpv_codes = cpvs[n.id]
        o.buyer_name = buyers.get(n.buyer_id) if n.buyer_id else None
        out.append(o)
    return out


@router.get(
    "", response_model=NoticePage, summary="List and filter notices (newest first, cursor pagination)"
)
def list_notices(
    _: UserId,
    f: Annotated[NoticeFilters, Depends(_filters)],
    cursor: str | None = None,
    limit: int = 50,
) -> NoticePage:
    with public_session() as db:
        rows, nxt = paginate(
            db, apply_filters(select(Notice), f), Notice.created_at, Notice.id, cursor, limit
        )
        return NoticePage(items=to_out(db, rows), next_cursor=nxt)


@router.get("/{notice_id}", response_model=NoticeOut)
def get_notice(notice_id: uuid.UUID, _: UserId) -> NoticeOut:
    with public_session() as db:
        n = db.get(Notice, notice_id)
        if n is None:
            raise not_found("Notice")
        return to_out(db, [n])[0]


@router.get("/{notice_id}/versions", response_model=list[VersionOut], summary="Version history (corrigenda)")
def notice_versions(notice_id: uuid.UUID, _: UserId) -> list[NoticeVersion]:
    with public_session() as db:
        if db.get(Notice, notice_id) is None:
            raise not_found("Notice")
        return list(
            db.scalars(
                select(NoticeVersion)
                .where(NoticeVersion.notice_id == notice_id)
                .order_by(NoticeVersion.version)
            )
        )
