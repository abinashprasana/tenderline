from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from tenderline.api.deps import CanRead
from tenderline.models import AuditLog
from tenderline.pagination import paginate

router = APIRouter(prefix="/v1/organisations/{org_id}/audit-log", tags=["audit"])


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    occurred_at: datetime
    actor_type: str
    actor_id: str
    action: str
    entity_type: str
    entity_id: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    trace_id: str | None


class AuditPage(BaseModel):
    items: list[AuditOut]
    next_cursor: str | None


@router.get("", response_model=AuditPage, summary="Read-only, filterable audit log (newest first)")
def list_audit(
    org_id: uuid.UUID,
    ctx: CanRead,
    action: str | None = None,
    action_prefix: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    actor_type: str | None = None,
    actor_id: str | None = None,
    trace_id: str | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> AuditPage:
    stmt = select(AuditLog)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if action_prefix:
        stmt = stmt.where(AuditLog.action.like(f"{action_prefix}%"))
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if actor_type:
        stmt = stmt.where(AuditLog.actor_type == actor_type)
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    if trace_id:
        stmt = stmt.where(AuditLog.trace_id == trace_id)
    if occurred_from:
        stmt = stmt.where(AuditLog.occurred_at >= occurred_from)
    if occurred_to:
        stmt = stmt.where(AuditLog.occurred_at < datetime.combine(occurred_to, datetime.max.time()))
    rows, nxt = paginate(ctx.db, stmt, AuditLog.occurred_at, AuditLog.id, cursor, limit)
    return AuditPage(items=[AuditOut.model_validate(r) for r in rows], next_cursor=nxt)
