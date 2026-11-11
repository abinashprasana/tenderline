"""Reference data the UI needs for pickers."""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from tenderline.api.deps import RateLimitedUserId
from tenderline.db import public_session
from tenderline.models import CpvCode

router = APIRouter(prefix="/v1/cpv-codes", tags=["reference"])


class CpvOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    division: str
    description: str | None


@router.get("", response_model=list[CpvOut], summary="Search CPV codes by code prefix or label")
def search_cpv_codes(
    _: RateLimitedUserId,
    q: str = Query(default="", max_length=100),
    divisions_only: bool = False,
    limit: int = Query(default=30, ge=1, le=200),
) -> list[CpvCode]:
    """Digits search by code prefix (`72` finds every IT service code); words search the English label.
    `divisions_only` returns the 2-digit top level (codes ending in six zeros)."""
    statement = select(CpvCode).where(CpvCode.description.is_not(None))
    term = q.strip()
    if term.isdigit():
        statement = statement.where(CpvCode.code.like(f"{term}%"))
    elif term:
        words = [word for word in term.split() if word]
        statement = statement.where(*[CpvCode.description.ilike(f"%{word}%") for word in words])
    if divisions_only:
        statement = statement.where(CpvCode.code.like("__000000"))
    with public_session() as db:
        return list(db.scalars(statement.order_by(CpvCode.code).limit(limit)))
